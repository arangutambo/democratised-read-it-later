/**
 * A saved web page as something you can read and point at.
 *
 * Two things about real exported articles decide the shape of this file, both found by opening
 * the 5,479 HTML files in a Readwise export rather than by reasoning about HTML:
 *
 *  - **They are body fragments.** No `<html>`, no `<head>`, no `<title>` — the first byte is
 *    `<p>`. So the title cannot come from the document and has to be passed in, and the parse
 *    has to work on a fragment without inventing a wrapper that changes what the selectors see.
 *  - **Their images are remote URLs**, not embedded files. That is the whole privacy question
 *    for this milestone, and it is handled in `sanitise.ts`, not here.
 *
 * Sectioning exists for the same reason it does in an EPUB: one of these articles is 128 KB,
 * and handing the virtualiser a single element defeats it. Headings are the only structure a
 * web page reliably has, so they are the seam.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

export interface ArticleSection {
	index: number;
	/** The heading that opens this section, when it has one. Becomes the table of contents. */
	title?: string;
	/** Depth of that heading, 1–6, for indenting the outline. */
	depth?: number;
	/** The section's own nodes, as an element ready to sanitise. */
	body: HTMLElement;
}

export interface ParsedArticle {
	/** From `<title>` or the first `<h1>`. Undefined for a fragment, where the caller knows. */
	title?: string;
	sections: ArticleSection[];
}

export type HtmlParser = (html: string) => Document;

/** Where a section begins. `h1` and `h2` only: deeper headings are structure *within* a read. */
const SEAM = new Set(["h1", "h2"]);

/**
 * Blocks after which a section is split regardless of headings.
 *
 * Headings alone do not work here, and that is a measurement rather than a guess: of 291 real
 * saved articles only 13 contain an `<h1>` or `<h2>` at all. Reader-mode extraction has
 * usually already flattened them away. Meanwhile the articles themselves are not small — a
 * median of 38 KB, a p99 of 369 KB and one of 772 KB — so a purely heading-based split hands
 * the virtualiser a single enormous element for 94% of the corpus, which is the exact thing it
 * exists to prevent.
 *
 * 40 leaves a median article as one section and cuts the outliers into pieces that render.
 */
const BLOCK_LIMIT = 40;

/**
 * Parse an article into sections.
 *
 * The document is not modified — sections hold clones — so the caller can parse once and
 * render sections repeatedly as the virtualiser moves.
 */
export function parseArticle(html: string, parse: HtmlParser): ParsedArticle {
	const doc = parse(html);
	const body = doc.body ?? doc.documentElement;
	const root = contentRoot(body);

	return { title: titleOf(doc, body), sections: sectionsOf(doc, root) };
}

/** Wrappers worth seeing through. `p` is deliberately absent — see `contentRoot`. */
const WRAPPER = new Set(["div", "article", "main", "section", "body"]);

/**
 * The element whose children are actually the article.
 *
 * A page wrapped in `<div><p>…</p>…</div>` has one top-level child, so splitting on the body's
 * children would find a single block and never split anything. Descending finds the real
 * content.
 *
 * `<p>` is not a wrapper even when it holds everything. A Readwise YouTube transcript is one
 * enormous `<p>` of per-phrase `<span>`s — 772 KB in the largest — and descending into it would
 * make each section a fragment of a sentence. Transcripts are their own document type and get
 * handled as one rather than being mangled into an article here.
 */
function contentRoot(body: Element): Element {
	let root = body;

	while (true) {
		const children = Array.from(root.children);
		if (children.length !== 1) return root;

		const only = children[0];
		if (!WRAPPER.has(only.tagName.toLowerCase())) return root;
		root = only;
	}
}

function titleOf(doc: Document, root: Element): string | undefined {
	const declared = doc.querySelector("title")?.textContent?.trim();
	if (declared) return declared;

	// A fragment has no <title>; its first h1 is the next best thing, and often the only one.
	const heading = root.querySelector("h1")?.textContent?.trim();
	return heading || undefined;
}

function sectionsOf(doc: Document, root: Element): ArticleSection[] {
	const sections: ArticleSection[] = [];
	let current: ArticleSection | undefined;

	const start = (title?: string, depth?: number): ArticleSection => {
		const section: ArticleSection = {
			index: sections.length + 1,
			title,
			depth,
			body: doc.createElement("div"),
		};
		sections.push(section);
		return section;
	};

	let blocks = 0;

	for (const node of Array.from(root.childNodes)) {
		const tag = node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";

		if (SEAM.has(tag)) {
			const heading = node as HTMLElement;
			current = start(heading.textContent?.trim() || undefined, Number(tag.slice(1)));
			blocks = 0;
		} else if (!current) {
			/*
			 * Text before the first heading, which is the normal case: a Readwise article opens
			 * with a paragraph. It is a section with no title rather than something to drop.
			 */
			if (tag === "" && (node.textContent ?? "").trim() === "") continue;
			current = start();
			blocks = 0;
		} else if (tag !== "" && blocks >= BLOCK_LIMIT) {
			// A continuation, so deliberately untitled: it is not a heading and must not
			// appear in the table of contents as though it were one.
			current = start();
			blocks = 0;
		}

		current.body.appendChild(node.cloneNode(true));
		if (tag !== "") blocks++;
	}

	// An empty document is one empty section, so the view has something to render and say.
	return sections.length > 0 ? sections : [start()];
}

/**
 * Elements that end a run of text.
 *
 * `textContent` concatenates without regard for layout, so `<h2>First</h2><p>One.</p>` comes
 * back as `FirstOne.` — two words fused into one. That matters here rather than being untidy:
 * this string is a quote's prefix and suffix and the corpus that search matches against, so a
 * fused word makes an anchor that cannot be found and a search that misses. The same class of
 * bug already had to be fixed once for PDF line joins.
 */
const BLOCK = new Set([
	"address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption",
	"figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol",
	"p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** A section's plain text, for search and for a quote's surrounding context. */
export function sectionText(section: ArticleSection): string {
	const parts: string[] = [];

	const walk = (node: Node): void => {
		if (node.nodeType === 3) {
			parts.push(node.nodeValue ?? "");
			return;
		}
		if (node.nodeType !== 1) return;

		const block = BLOCK.has((node as Element).tagName.toLowerCase());
		if (block) parts.push(" ");
		for (const child of Array.from(node.childNodes)) walk(child);
		if (block) parts.push(" ");
	};

	walk(section.body);
	return parts.join("").replace(/\s+/g, " ").trim();
}

/** The outline, as the reader's table of contents wants it. */
export function outlineOf(sections: readonly ArticleSection[]): { title: string; depth: number; page?: number }[] {
	return sections
		.filter((section) => section.title !== undefined)
		.map((section) => ({ title: section.title as string, depth: (section.depth ?? 1) - 1, page: section.index }));
}
