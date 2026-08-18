/**
 * Taking the picture that is on screen right now.
 *
 * A YouTube player is cross-origin, so the usual routes are all closed: `drawImage` cannot
 * take an iframe, and reading pixels out of one taints the canvas. The way through is not a
 * DOM API at all — Electron's `capturePage(rect)` asks Chromium for its own compositor output
 * for a region of the window, which is a screenshot of what was actually drawn. It is the
 * mechanism Obsidian's own screenshot command uses.
 *
 * This is why a frame can be exact. Storyboard thumbnails, the other way to get a picture out
 * of a video without downloading it, exist only every ten seconds and at 320×180 — fine for
 * "roughly what was on screen", useless for a specific moment.
 */

export interface CaptureRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The Electron surface this needs, kept to the two calls actually used. */
interface WebContentsLike {
	capturePage(rect: CaptureRect): Promise<{ toPNG(): Uint8Array }>;
}

export interface CaptureDeps {
	/** Resolves the current window's web contents, or undefined off desktop. */
	webContents(): WebContentsLike | undefined;
	/** Device pixel ratio; a rect is given in CSS pixels but captured in device pixels. */
	pixelRatio: number;
}

/**
 * An element's position in the window, rounded to whole pixels.
 *
 * `capturePage` takes integers and silently misbehaves on fractional ones, and a video player
 * sitting at a fractional offset is the normal case once a pane has been resized.
 */
export function rectOf(bounds: DOMRect): CaptureRect {
	const x = Math.round(bounds.left);
	const y = Math.round(bounds.top);

	return {
		x,
		y,
		width: Math.max(1, Math.round(bounds.right) - x),
		height: Math.max(1, Math.round(bounds.bottom) - y),
	};
}

export class FrameCaptureError extends Error {}

/**
 * Capture the region an element occupies.
 *
 * Fails loudly rather than writing a blank image: a black or empty frame in a note is worse
 * than no frame, because you will not notice until the video is long closed.
 */
export async function captureFrame(bounds: DOMRect, deps: CaptureDeps): Promise<Uint8Array> {
	const contents = deps.webContents();
	if (!contents) {
		throw new FrameCaptureError(
			"Capturing a frame needs the desktop app — a browser cannot read a video player's pixels.",
		);
	}

	const rect = rectOf(bounds);
	if (rect.width < 8 || rect.height < 8) {
		throw new FrameCaptureError("The player is too small to capture. Widen the pane and try again.");
	}

	const image = await contents.capturePage(rect);
	const png = image.toPNG();

	if (png.length === 0) throw new FrameCaptureError("The capture came back empty.");
	return png;
}

/**
 * The current window's web contents, on desktop.
 *
 * Reached through Obsidian's own `window.electron.remote`, which is the same route its
 * screenshot command takes. Undefined anywhere that bridge is absent — mobile, or a future
 * build with `contextIsolation` on — and the caller turns that into a message rather than a
 * crash.
 */
export function currentWebContents(): { capturePage(rect: CaptureRect): Promise<{ toPNG(): Uint8Array }> } | undefined {
	const bridge = (window as unknown as {
		electron?: { remote?: { getCurrentWebContents?: () => unknown } };
	}).electron;

	try {
		const contents = bridge?.remote?.getCurrentWebContents?.();
		return typeof (contents as { capturePage?: unknown })?.capturePage === "function"
			? (contents as { capturePage(rect: CaptureRect): Promise<{ toPNG(): Uint8Array }> })
			: undefined;
	} catch {
		return undefined;
	}
}
