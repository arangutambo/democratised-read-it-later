/**
 * Saving a page you are reading into the vault.
 *
 * This is the first thing in the plugin that reaches the network on your behalf, and it does so
 * only when you paste a URL and press save. What comes back is written to disk as a document
 * and opened in Reader — from then on it is a local file like any other, readable offline, and
 * clipped with the same keys.
 *
 * The page is sanitised on the way in, not on the way out. Storing raw third-party HTML in a
 * vault means every later render trusts whatever was in it; storing the cleaned form means the
 * dangerous shapes never touch disk at all.
 */

import { requestUrl } from "obsidian";

/** Where a saved page ends up, before it becomes a `.reader` pair. */
export interface SavedPage {
	/** Sanitised HTML, ready to write. */
	html: string;
	/** From `<title>`, `og:title`, or the first heading. Falls back to the host. */
	title: string;
	/** The URL actually fetched, after redirects. */
	url: string;
}

export class SaveUrlError extends Error {}

/** Only http(s). A `file:` or `app:` URL here would read the user's own disk. */
export function isSaveableUrl(input: string): boolean {
	try {
		const url = new URL(input.trim());
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

/** `https://` when someone pastes a bare host. */
export function normaliseUrl(input: string): string {
	const trimmed = input.trim();
	return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * A filename for the page, from its title.
 *
 * Same sanitising as everywhere else: a vault path cannot hold these, and a colon breaks
 * silently on Windows.
 */
export function fileNameFor(title: string, url: string): string {
	const cleaned = title.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();

	if (/[\p{L}\p{N}]/u.test(cleaned)) return cleaned.slice(0, 100).trim();

	// A title of only punctuation is no title; the host at least says where it came from.
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "Saved page";
	}
}

/** The page's own title, in the order a reader would expect it. */
export function titleOf(doc: Document, url: string): string {
	const og = doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
	if (og) return og;

	const declared = doc.querySelector("title")?.textContent?.trim();
	if (declared) return declared;

	const heading = doc.querySelector("h1")?.textContent?.trim();
	if (heading) return heading;

	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "Saved page";
	}
}

/**
 * Fetch a page.
 *
 * Through `requestUrl` because a plugin runs in the renderer, where a cross-origin fetch is
 * blocked — and because it follows redirects and hands back the final URL, which is what a
 * shortened or tracking link resolves to.
 */
export async function fetchPage(input: string): Promise<{ html: string; url: string }> {
	const url = normaliseUrl(input);

	if (!isSaveableUrl(url)) {
		throw new SaveUrlError("That is not a web address Reader can save.");
	}

	let response: { status: number; text: string; headers: Record<string, string> };

	try {
		response = await requestUrl({
			url,
			method: "GET",
			headers: {
				// Identifying as a browser: many publishers serve a stub to anything else, and a
				// saved stub is worse than a clear failure.
				"user-agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
				accept: "text/html,application/xhtml+xml",
			},
			throw: false,
		});
	} catch (error) {
		throw new SaveUrlError(
			`Could not reach that page: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (response.status === 404) throw new SaveUrlError("That page does not exist (404).");
	if (response.status === 403 || response.status === 401) {
		throw new SaveUrlError("That page refused the request — it may need a login.");
	}
	if (response.status >= 400) {
		throw new SaveUrlError(`That page returned ${response.status}.`);
	}

	const type = (response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? "").toLowerCase();
	if (type !== "" && !type.includes("html")) {
		throw new SaveUrlError(`That is not a web page (${type.split(";")[0]}). Download it and open it directly.`);
	}

	if (response.text.trim() === "") throw new SaveUrlError("That page came back empty.");

	return { html: response.text, url };
}
