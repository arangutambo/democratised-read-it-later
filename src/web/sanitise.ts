/**
 * Making a saved web page safe to read, and deciding what happens to its pictures.
 *
 * The safety half is the EPUB sanitiser unchanged — an allow-list over a parsed DOM, because
 * this is arbitrary markup from a stranger rendered inside an app that has Node and the whole
 * vault. The part that is specific to the web is images.
 *
 * A saved article's images are all remote: in a real Readwise export every single `src` is an
 * absolute URL on someone else's CDN. That makes rendering them a network decision, not a
 * display one. Loading them means the host learns your IP and the moment you opened the
 * article — which, for a reader whose point is to be local and in your vault, is not a default
 * to make on your behalf. It is also exactly how a tracking pixel works.
 *
 * So: nothing is fetched on open. Each image becomes a placeholder naming its host, and you
 * load them per document when you want them. The capability is kept; the silent leak is not.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import { sanitiseSection, type SanitiseOptions } from "../epub/sanitise";

/** Marks a placeholder standing in for an unloaded remote image. */
export const BLOCKED_IMAGE_CLASS = "reader-remote-image";

export interface WebSanitiseOptions {
	/**
	 * Load remote images rather than blocking them.
	 *
	 * Per document and never remembered globally: consenting to fetch from one publisher's CDN
	 * is not consent to fetch from every one.
	 */
	loadRemoteImages?: boolean;
	/** Resolves an image the article shipped with — a data: URI, or a file beside it. */
	resolveImage?: (src: string) => string | undefined;
}

/** The host an image would be fetched from, for the placeholder's label. */
export function hostOf(src: string): string {
	const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(src);
	return match ? match[1] : "elsewhere";
}

/**
 * Sanitise an article section.
 *
 * `loadRemoteImages` is the only difference between a page that renders its pictures and one
 * that does not; everything else about the markup is treated identically either way.
 */
export function sanitiseArticle(
	body: HTMLElement,
	doc: Document,
	options: WebSanitiseOptions = {},
): HTMLElement {
	const sanitiseOptions: SanitiseOptions = {
		resolveImage: (src) => options.resolveImage?.(src),
		remoteImage: options.loadRemoteImages
			? (src, ownerDoc) => keepRemote(src, ownerDoc)
			: (src, ownerDoc) => placeholderFor(src, ownerDoc),
	};

	// The sanitiser walks a document's body; an article section is a detached div, so it is
	// given one of its own rather than the section being reparented into the live page.
	const holder = doc.implementation.createHTMLDocument("");
	holder.body.appendChild(holder.importNode(body, true));

	const cleaned = sanitiseSection(holder, sanitiseOptions);
	return doc.importNode(cleaned, true) as HTMLElement;
}

/**
 * The image, loaded.
 *
 * Rebuilt rather than kept so it carries only the attributes an allow-list would have left,
 * and `referrerpolicy` so the host is not also told which page you were reading it from.
 */
function keepRemote(src: string, doc: Document): Element {
	const img = doc.createElement("img");
	img.setAttribute("src", src);
	img.setAttribute("referrerpolicy", "no-referrer");
	img.dataset.readerRemote = src;
	return img;
}

/** A stand-in that names what would be fetched and from where, and fetches nothing. */
function placeholderFor(src: string, doc: Document): Element {
	const span = doc.createElement("span");
	span.className = BLOCKED_IMAGE_CLASS;
	span.dataset.readerRemote = src;
	span.setAttribute("role", "img");
	span.setAttribute("aria-label", `Image from ${hostOf(src)}, not loaded`);
	span.textContent = `image — ${hostOf(src)}`;
	return span;
}
