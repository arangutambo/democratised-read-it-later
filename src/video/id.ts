/**
 * Getting a video id out of whatever you pasted.
 *
 * The id is the only stable handle: it survives the tracking parameters a share sheet adds,
 * the `si=` token, the redirect wrapper a search result comes wrapped in, and the difference
 * between `youtube.com/watch`, `youtu.be` and an embed. Everything downstream keys on it.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** Eleven characters of URL-safe base64. YouTube has never used anything else. */
const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id in a URL, or undefined.
 *
 * Unwraps a redirect first — a link copied out of a search result arrives as
 * `google.com/url?...&url=<the real one>&usg=...`, and the id is inside the encoded parameter
 * rather than anywhere in the outer URL.
 */
export function videoIdFrom(input: string): string | undefined {
	const raw = input.trim();
	if (raw === "") return undefined;

	// A bare id, which is what a second call on our own output looks like.
	if (ID.test(raw)) return raw;

	let url: URL;
	try {
		url = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		return undefined;
	}

	// A redirector carries the real URL in a parameter; recurse into it rather than guessing.
	const wrapped = url.searchParams.get("url") ?? url.searchParams.get("q");
	if (wrapped && /youtu/.test(wrapped)) return videoIdFrom(wrapped);

	const host = url.hostname.replace(/^(www|m)\./, "");

	if (host === "youtu.be") return check(url.pathname.slice(1));

	if (host === "youtube.com" || host === "youtube-nocookie.com") {
		const v = url.searchParams.get("v");
		if (v) return check(v);

		// /embed/<id>, /shorts/<id>, /live/<id>, /v/<id> all put it in the path.
		const match = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
		if (match) return check(match[1]);
	}

	return undefined;
}

function check(candidate: string): string | undefined {
	return ID.test(candidate) ? candidate : undefined;
}

/** The canonical watch URL, which is what the reader loads and what the note records. */
export function watchUrl(id: string): string {
	return `https://www.youtube.com/watch?v=${id}`;
}

/** Whether a URL is a video Reader can open. */
export function isVideoUrl(input: string): boolean {
	return videoIdFrom(input) !== undefined;
}
