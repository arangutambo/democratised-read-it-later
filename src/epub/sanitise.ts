/**
 * Making a book's markup safe to put in the app.
 *
 * An EPUB is arbitrary HTML from a stranger, rendered inside Obsidian, which has Node and the
 * user's whole vault. So this is a security boundary, not tidying: a book that can run a
 * script can do anything the plugin can.
 *
 * Allow-list, not block-list. A block-list is a list of the attacks someone thought of.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** Elements that carry a book's meaning. Everything else is unwrapped or dropped. */
const ALLOWED = new Set([
	"a", "abbr", "aside", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
	"dd", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
	"hr", "i", "img", "li", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "section",
	"small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
	"time", "tr", "u", "ul", "wbr",
]);

/** Dropped outright, with their contents: nothing inside them is text you want to read. */
const DISCARD = new Set(["script", "style", "link", "meta", "head", "iframe", "object", "embed", "audio", "video", "svg", "form", "input", "button"]);

/** Attributes kept, per element. Everything else goes — including every `on*` handler. */
const ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(["href", "id", "title"]),
	img: new Set(["src", "alt", "width", "height", "id"]),
	td: new Set(["colspan", "rowspan", "id"]),
	th: new Set(["colspan", "rowspan", "scope", "id"]),
	col: new Set(["span"]),
	colgroup: new Set(["span"]),
	ol: new Set(["start", "type", "id"]),
};

/** Every element may keep these. `id` is what an internal link points at. */
const UNIVERSAL = new Set(["id"]);

export interface SanitiseOptions {
	/**
	 * Turns an archive path into something the app can load — an object URL, usually.
	 *
	 * Returning undefined drops the image, which is right for a src that escapes the archive.
	 */
	resolveImage(src: string): string | undefined;
}

/**
 * Sanitise a section's body in place, returning the element to display.
 *
 * Works on a parsed document rather than on a string: string-level sanitising is how mistakes
 * are made, because the thing you are pattern-matching is exactly the thing a parser
 * interprets differently from you.
 */
export function sanitiseSection(doc: Document, options: SanitiseOptions): HTMLElement {
	const body = doc.body ?? doc.documentElement;

	for (const node of Array.from(body.querySelectorAll("*"))) {
		const tag = node.tagName.toLowerCase();

		if (DISCARD.has(tag)) {
			node.remove();
			continue;
		}

		if (!ALLOWED.has(tag)) {
			// Unknown but harmless: keep the words, drop the element. A book full of custom
			// tags should still read, and dropping the subtree would delete its text.
			unwrap(node);
			continue;
		}

		const allowed = ATTRIBUTES[tag] ?? new Set<string>();
		for (const attribute of Array.from(node.attributes)) {
			const name = attribute.name.toLowerCase();
			if (!allowed.has(name) && !UNIVERSAL.has(name)) {
				node.removeAttribute(attribute.name);
			}
		}

		if (tag === "img") rewriteImage(node as HTMLImageElement, options);
		if (tag === "a") rewriteLink(node as HTMLAnchorElement);
	}

	return body as HTMLElement;
}

/** Replace an element with its children, keeping the text. */
function unwrap(node: Element): void {
	const parent = node.parentNode;
	if (!parent) return;
	while (node.firstChild) parent.insertBefore(node.firstChild, node);
	parent.removeChild(node);
}

function rewriteImage(img: HTMLImageElement, options: SanitiseOptions): void {
	const src = img.getAttribute("src") ?? "";

	// A remote image would phone home the moment a page rendered, telling a publisher when and
	// where the book was read. Only what is inside the archive is loaded.
	if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("data:")) {
		img.remove();
		return;
	}

	const resolved = options.resolveImage(src);
	if (!resolved) {
		img.remove();
		return;
	}

	// The original path is kept so a clip of this figure can find the file in the archive.
	img.dataset.readerSrc = src;
	img.setAttribute("src", resolved);
}

function rewriteLink(anchor: HTMLAnchorElement): void {
	const href = anchor.getAttribute("href") ?? "";

	/*
	 * `javascript:` is the obvious one. `file:` and `app:` matter too, because inside Electron
	 * they reach the filesystem — and this markup came from a file someone else made.
	 */
	if (/^\s*(javascript|data|file|app|vbscript):/i.test(href)) {
		anchor.removeAttribute("href");
		return;
	}

	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
		// An external link is fine to follow, but not silently and not in this window.
		anchor.setAttribute("target", "_blank");
		anchor.setAttribute("rel", "noopener noreferrer");
	}
}
