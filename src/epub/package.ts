/**
 * An EPUB's package document: what is in the book, and in what order it reads.
 *
 * Three hops, and each one exists for a reason worth knowing:
 *
 *   `META-INF/container.xml`  the only file at a fixed path. Everything else is found through
 *                             it, because a publisher may put the content anywhere.
 *   the OPF                   the manifest (every file) and the spine (reading order). They
 *                             are different lists: the manifest holds images, styles and a
 *                             table of contents that are not sections you read.
 *   each spine item           one XHTML document — a chapter, or part of one.
 *
 * Paths inside an EPUB are relative to the file that names them, which is where naive joining
 * goes wrong: `text/ch2.xhtml` in an OPF at `OEBPS/content.opf` is `OEBPS/text/ch2.xhtml`,
 * and a chapter linking to `../images/fig.png` means exactly that.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

export class EpubError extends Error {}

export interface ManifestItem {
	id: string;
	/** Full path within the archive, already resolved. */
	path: string;
	mediaType: string;
	properties: string[];
}

export interface EpubPackage {
	title?: string;
	creator?: string;
	language?: string;
	/** Reading order: the sections you actually turn through. */
	spine: ManifestItem[];
	manifest: Map<string, ManifestItem>;
	/** The EPUB 3 navigation document, when the book has one. */
	navPath?: string;
	/** Directory the OPF lives in — every href inside it is relative to this. */
	root: string;
}

/**
 * Resolve `href` against the directory `base`.
 *
 * Written out rather than using `URL`, because an EPUB path is not a URL and feeding one to
 * `new URL()` requires inventing an origin, which then leaks into the result.
 */
export function resolveHref(base: string, href: string): string {
	const decoded = decodeURIComponent(href.split("#")[0]);
	if (decoded.startsWith("/")) return decoded.replace(/^\/+/, "");

	const parts = base === "" ? [] : base.split("/").filter((p) => p !== "");
	for (const segment of decoded.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	return parts.join("/");
}

/** The directory part of a path, without a trailing slash. */
export function dirnameOf(path: string): string {
	const at = path.lastIndexOf("/");
	return at === -1 ? "" : path.slice(0, at);
}

/** Where the package document lives, per `META-INF/container.xml`. */
export function findRootfile(containerXml: string, parse: XmlParser): string {
	const doc = parse(containerXml);
	const rootfile = doc.querySelector("rootfile");
	const path = rootfile?.getAttribute("full-path");

	if (!path) throw new EpubError("This EPUB's container names no package document.");
	return path;
}

/** Anything that turns XML into something queryable. `DOMParser` in both Obsidian and Node. */
export type ParsedXml = {
	querySelector(selector: string): ElementLike | null;
	querySelectorAll(selector: string): ArrayLike<ElementLike>;
};

export type XmlParser = (xml: string) => ParsedXml;

export interface ElementLike {
	getAttribute(name: string): string | null;
	textContent: string | null;
	/** Present on a real DOM; used to match namespaced names without escaping a colon. */
	localName?: string;
	tagName?: string;
	querySelector(selector: string): ElementLike | null;
	querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

export function parsePackage(opfXml: string, opfPath: string, parse: XmlParser): EpubPackage {
	const doc = parse(opfXml);
	const root = dirnameOf(opfPath);

	const manifest = new Map<string, ManifestItem>();
	for (const node of Array.from(doc.querySelectorAll("manifest item"))) {
		const id = node.getAttribute("id");
		const href = node.getAttribute("href");
		if (!id || !href) continue;

		manifest.set(id, {
			id,
			path: resolveHref(root, href),
			mediaType: node.getAttribute("media-type") ?? "",
			properties: (node.getAttribute("properties") ?? "").split(/\s+/).filter((p) => p !== ""),
		});
	}

	/*
	 * The spine, not the manifest, is the book.
	 *
	 * A manifest lists every file including images, stylesheets and the table of contents; the
	 * spine lists only what you read, in order. Treating the manifest as the reading order is
	 * how a reader ends up showing you a stylesheet as chapter three.
	 */
	const spine: ManifestItem[] = [];
	for (const node of Array.from(doc.querySelectorAll("spine itemref"))) {
		const idref = node.getAttribute("idref");
		// `linear="no"` marks material out of the main flow, but it is still readable and
		// hiding it loses appendices, so it is kept.
		const item = idref ? manifest.get(idref) : undefined;
		if (item) spine.push(item);
	}

	if (spine.length === 0) throw new EpubError("This EPUB has no readable sections.");

	const nav = [...manifest.values()].find((item) => item.properties.includes("nav"));

	return {
		title: metadataOf(doc, "title"),
		creator: metadataOf(doc, "creator"),
		language: metadataOf(doc, "language"),
		spine,
		manifest,
		navPath: nav?.path,
		root,
	};
}

/**
 * A Dublin Core field from the package metadata.
 *
 * These are namespaced — `<dc:title>` — and a CSS selector cannot match a prefixed name
 * without escaping the colon, which is brittle across parsers. Matching on the local name
 * works whether the document declares `dc:`, some other prefix, or none.
 */
function metadataOf(doc: ParsedXml, name: string): string | undefined {
	for (const node of Array.from(doc.querySelectorAll("metadata > *"))) {
		const local = (node.localName ?? node.tagName ?? "").toLowerCase();
		if (local === name || local.endsWith(`:${name}`)) {
			const value = node.textContent?.trim();
			if (value) return value;
		}
	}
	return undefined;
}

export interface NavEntry {
	title: string;
	depth: number;
	/** Archive path of the section it points at. */
	path: string;
}

/**
 * The book's table of contents, from its EPUB 3 navigation document.
 *
 * Depth comes from nesting of the lists, which is how a navigation document expresses
 * hierarchy — there is no depth attribute to read.
 */
export function parseNav(navXhtml: string, navPath: string, parse: XmlParser): NavEntry[] {
	const doc = parse(navXhtml);
	const base = dirnameOf(navPath);
	const out: NavEntry[] = [];

	const nav = doc.querySelector("nav") ?? doc.querySelector("body");
	if (!nav) return out;

	const walk = (list: ElementLike, depth: number): void => {
		for (const item of Array.from(list.querySelectorAll(":scope > li"))) {
			const anchor = item.querySelector(":scope > a");
			const href = anchor?.getAttribute("href");
			const title = anchor?.textContent?.trim();

			if (href && title) out.push({ title, depth, path: resolveHref(base, href) });

			const nested = item.querySelector(":scope > ol");
			if (nested) walk(nested, depth + 1);
		}
	};

	const first = nav.querySelector("ol");
	if (first) walk(first, 0);
	return out;
}
