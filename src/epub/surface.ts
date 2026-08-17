/**
 * A book as a sequence of sections you can point at.
 *
 * One spine section is rendered at a time and the previous one is released — never the whole
 * book. That was asked for as a reading preference ("so it doesn't clog up") and is also the
 * only way a 22 MB pharmacology manual is survivable on an iPad, which is the happy case where
 * the tidy answer and the necessary one agree.
 *
 * Unlike a PDF, an EPUB's text is already a DOM. So selection needs no invisible text layer,
 * structure comes from real headings and lists, and a figure clip is the publisher's own image
 * file rather than a screenshot of it.
 */

import type { NormalisedRect } from "../capture/types";
import type { DocumentSurfaces, SurfaceSize } from "../reader/surface/surface";
import {
	findRootfile,
	parseNav,
	parsePackage,
	resolveHref,
	dirnameOf,
	type EpubPackage,
	type NavEntry,
	type XmlParser,
} from "./package";
import { parseXml } from "./parse-xml";
import { sanitiseSection } from "./sanitise";
import { ZipArchive } from "./zip";

export interface EpubSection {
	index: number;
	path: string;
	/** The section's own heading, when it has one. Used for the table of contents. */
	title?: string;
}

export interface RenderedSection {
	element: HTMLElement;
	/** Object URLs created for this section, to be revoked when it is released. */
	release: () => void;
}

export class EpubSurface implements DocumentSurfaces {
	readonly kind = "epub-section" as const;
	/**
	 * A section has no bounded page, so "clip the whole surface" has no meaning — the same
	 * answer as a web article. Key 3 reports that rather than inventing one.
	 */
	readonly wholeSurfaceIsClippable = false;

	private readonly zip: ZipArchive;
	private readonly pkg: EpubPackage;
	private readonly nav: NavEntry[];

	private constructor(zip: ZipArchive, pkg: EpubPackage, nav: NavEntry[]) {
		this.zip = zip;
		this.pkg = pkg;
		this.nav = nav;
	}

	static async open(bytes: Uint8Array, parse: XmlParser = parseXml as XmlParser): Promise<EpubSurface> {
		const zip = ZipArchive.open(bytes);

		const opfPath = findRootfile(await zip.readText("META-INF/container.xml"), parse);
		const pkg = parsePackage(await zip.readText(opfPath), opfPath, parse);

		let nav: NavEntry[] = [];
		if (pkg.navPath && zip.has(pkg.navPath)) {
			// A malformed contents page costs the sidebar, never the book.
			nav = await zip
				.readText(pkg.navPath)
				.then((xhtml) => parseNav(xhtml, pkg.navPath as string, parse))
				.catch(() => []);
		}

		return new EpubSurface(zip, pkg, nav);
	}

	get count(): number {
		return this.pkg.spine.length;
	}

	get title(): string | undefined {
		return this.pkg.title;
	}

	get creator(): string | undefined {
		return this.pkg.creator;
	}

	/**
	 * A section has no intrinsic size — it is as tall as its text makes it.
	 *
	 * Reported as the unit square so normalised rects mean "a fraction of the rendered
	 * section", which is what the overlay needs and what survives a font-size change.
	 */
	async size(_index: number): Promise<SurfaceSize> {
		return { width: 1, height: 1 };
	}

	/** The table of contents, mapped onto spine indices. */
	outline(): { title: string; depth: number; page?: number }[] {
		const indexOf = new Map(this.pkg.spine.map((item, i) => [item.path, i + 1]));

		return this.nav.map((entry) => ({
			title: entry.title,
			depth: entry.depth,
			// A contents entry can point inside a section rather than at its start; the section
			// is the closest thing to a page an EPUB has.
			page: indexOf.get(entry.path),
		}));
	}

	/**
	 * Render one section, safe to insert.
	 *
	 * Images become object URLs pointing at bytes from the archive. They are revoked when the
	 * section is released, which is not optional: an object URL keeps its blob alive for the
	 * lifetime of the document, so a book scrolled end to end would hold every image it ever
	 * showed.
	 */
	async renderSection(index: number): Promise<RenderedSection> {
		const item = this.pkg.spine[this.clamp(index) - 1];
		const doc = parseXml(await this.zip.readText(item.path)) as unknown as Document;
		const base = dirnameOf(item.path);

		const urls: string[] = [];
		const images = new Map<string, string>();

		// Collected first so the sanitiser's resolver can stay synchronous.
		for (const img of Array.from(doc.querySelectorAll("img"))) {
			const src = img.getAttribute("src");
			if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;

			const path = resolveHref(base, src);
			if (!this.zip.has(path) || images.has(src)) continue;

			const bytes = await this.zip.read(path);
			const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
			images.set(src, url);
			urls.push(url);
		}

		const element = sanitiseSection(doc, { resolveImage: (src) => images.get(src) });

		return {
			element,
			release: () => {
				for (const url of urls) URL.revokeObjectURL(url);
				urls.length = 0;
			},
		};
	}

	/** A section's plain text, for search and for a quote's surrounding context. */
	async sectionText(index: number): Promise<string> {
		const item = this.pkg.spine[this.clamp(index) - 1];
		const doc = parseXml(await this.zip.readText(item.path)) as unknown as Document;
		return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
	}

	/**
	 * The bytes of a figure, straight from the archive.
	 *
	 * Deliberately not a screenshot. A PDF has to be rasterised because its figure is drawing
	 * instructions, but an EPUB's figure is already a file — so a clip is the publisher's own
	 * image at full resolution, at whatever size they shipped, with no DPI decision to make.
	 */
	async readImage(sectionIndex: number, src: string): Promise<{ bytes: Uint8Array; path: string } | undefined> {
		const item = this.pkg.spine[this.clamp(sectionIndex) - 1];
		const path = resolveHref(dirnameOf(item.path), src);

		if (!this.zip.has(path)) return undefined;
		return { bytes: await this.zip.read(path), path };
	}

	/**
	 * There is nothing to rasterise here, so this is not offered.
	 *
	 * `DocumentSurfaces` promises it, and an EPUB cannot honour it without screenshotting the
	 * DOM — which would produce a worse image than the one already in the archive. Figures are
	 * clipped with `readImage` instead, and `wholeSurfaceIsClippable` is false so the view
	 * never asks.
	 */
	async renderRegion(_index: number, _rect: NormalisedRect, _dpi: number): Promise<Uint8Array> {
		throw new Error(
			"A section is not a page. Clip a figure to take the book's own image, or select text to quote it.",
		);
	}

	async close(): Promise<void> {
		// The archive is bytes and a map; sections release their own object URLs.
	}

	private clamp(index: number): number {
		return Math.min(this.count, Math.max(1, Math.floor(index)));
	}
}
