/**
 * A saved web page as a sequence of sections you can point at.
 *
 * The same shape as `EpubSurface`, for the same reason: the view drives `DocumentSurfaces` and
 * nothing else, so the three keys, the overlay and the note writing are written once. What is
 * different is entirely about where the pictures live — a book carries its figures inside the
 * archive, an article points at someone else's server — and that difference is confined to
 * `sanitise.ts` and to `loadImages` below.
 */

import type { NormalisedRect } from "../capture/types";
import type { DocumentSurfaces, SurfaceSize } from "../reader/surface/surface";
import { outlineOf, parseArticle, sectionText, type ArticleSection } from "./article";
import { sanitiseArticle } from "./sanitise";

export interface RenderedArticleSection {
	element: HTMLElement;
	release: () => void;
}

export class WebSurface implements DocumentSurfaces {
	readonly kind = "html-article" as const;

	/**
	 * An article has no bounded page, so "clip the whole surface" has no meaning — the same
	 * answer as an EPUB section. Key 3 reports that rather than inventing one.
	 */
	readonly wholeSurfaceIsClippable = false;

	private readonly sections: ArticleSection[];
	private readonly doc: Document;
	private readonly declaredTitle?: string;

	/**
	 * Whether remote images are fetched. Off until asked, and per document — consenting to
	 * fetch from one publisher's CDN is not consent to fetch from every one.
	 */
	private remoteImages = false;

	private constructor(sections: ArticleSection[], doc: Document, title?: string) {
		this.sections = sections;
		this.doc = doc;
		this.declaredTitle = title;
	}

	static open(html: string, doc: Document = document): WebSurface {
		const article = parseArticle(html, (source) => new DOMParser().parseFromString(source, "text/html"));
		return new WebSurface(article.sections, doc, article.title);
	}

	get count(): number {
		return this.sections.length;
	}

	/** From `<title>` or a leading `<h1>`. Usually absent — 288 of 291 real files have none. */
	get title(): string | undefined {
		return this.declaredTitle;
	}

	/** Whether anything on this page would be fetched from elsewhere if images were loaded. */
	get hasRemoteImages(): boolean {
		return this.sections.some((section) => section.body.querySelector("img") !== null);
	}

	get imagesLoaded(): boolean {
		return this.remoteImages;
	}

	/**
	 * Start fetching this document's images.
	 *
	 * One way only, and not persisted: it applies to this document in this session. Reopening
	 * starts blocked again, because the reason to block was never about this one page.
	 */
	loadImages(): void {
		this.remoteImages = true;
	}

	/**
	 * An article has no intrinsic size — it is text that reflows to the pane.
	 *
	 * Reported as a square so anything that divides by it stays finite; nothing uses it to lay
	 * a section out, and `wholeSurfaceIsClippable` is false so nothing crops by it either.
	 */
	async size(_index: number): Promise<SurfaceSize> {
		return { width: 1, height: 1 };
	}

	outline(): { title: string; depth: number; page?: number }[] {
		return outlineOf(this.sections);
	}

	renderSection(index: number): RenderedArticleSection {
		const section = this.sections[this.clamp(index) - 1];
		const element = sanitiseArticle(section.body, this.doc, { loadRemoteImages: this.remoteImages });

		return {
			element,
			// Nothing is allocated that needs freeing: no object URLs, no decoded bytes. The
			// hook exists so the view releases every surface the same way.
			release: () => {},
		};
	}

	/** A section's plain text, for search and for a quote's surrounding context. */
	sectionText(index: number): string {
		return sectionText(this.sections[this.clamp(index) - 1]);
	}

	/**
	 * There is nothing to rasterise, so this is not offered.
	 *
	 * `DocumentSurfaces` promises it, and an article cannot honour it without screenshotting
	 * the DOM. A figure here is a URL on someone else's server rather than a file in an
	 * archive, so there is not even a local original to take — which is the honest reason this
	 * differs from the EPUB case.
	 */
	async renderRegion(_index: number, _rect: NormalisedRect, _dpi: number): Promise<Uint8Array> {
		throw new Error("An article is not a page. Select text to quote it.");
	}

	async close(): Promise<void> {
		// Parsed nodes only; nothing held open.
	}

	private clamp(index: number): number {
		return Math.min(this.count, Math.max(1, Math.floor(index)));
	}
}
