/**
 * Pages that only exist after JavaScript has run.
 *
 * `fetchPage` asks for the URL and reads what comes back, which is the right thing to do and
 * works for most of the web. It cannot work for the rest of it: an app shell is 800 bytes of
 * `<div id="root">` and two script tags, and no amount of parsing finds an article in that.
 * The saved page would be an empty file, which is why saving refuses rather than writing one.
 *
 * A webview is a real browser. Loading the page in one, letting its scripts run, and then
 * taking the DOM it built gets the article that a person would have seen — and it is the same
 * mechanism the YouTube transcripts already use, so nothing new is being trusted here.
 *
 * Desktop only: there is no webview on mobile, and the plain fetch remains the whole story
 * there.
 */

import { openHost, webviewsAvailable } from "obsidian-youtube-transcript";

/** Whether this build can render a page at all. */
export function canRenderPages(): boolean {
	return webviewsAvailable();
}

export interface RenderOptions {
	/** Give up after this long, rendered or not. */
	timeoutMs?: number;
	/** Enough text on the page to call it arrived. */
	readableChars?: number;
	onProgress?: (message: string) => void;
}

const POLL_MS = 300;

/**
 * Load a page in a hidden webview and return the DOM its scripts built.
 *
 * Polled rather than given a fixed pause: a fixed pause is either too short for a slow app or
 * wasted on a fast one, and what is actually being waited for — text on the page — can simply
 * be asked about.
 */
export async function renderPage(url: string, options: RenderOptions = {}): Promise<string> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const readable = options.readableChars ?? 200;

	options.onProgress?.("Opening the page…");

	const host = await openHost(url, {
		// A persistent partition so a site that asked for a cookie decision once is not asked
		// again on every save.
		partition: "persist:reading-room-web",
		visible: false,
	});

	try {
		const deadline = Date.now() + timeoutMs;
		let best = "";

		while (Date.now() < deadline) {
			const raw = await host.view.executeJavaScript(
				`JSON.stringify({ text: (document.body && document.body.innerText || "").trim().length, html: document.documentElement.outerHTML })`,
			);

			const { text, html } = JSON.parse(String(raw)) as { text: number; html: string };
			best = html;

			if (text >= readable) return html;

			options.onProgress?.("Waiting for the page to render…");
			await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
		}

		// Out of time: hand back whatever it managed to build. The caller decides whether there
		// is an article in it, which is the same judgement it makes about a plain fetch.
		return best;
	} finally {
		host.dispose();
	}
}
