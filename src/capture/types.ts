/**
 * What a clip is, and where it came from.
 *
 * Two rules shape everything here, and both come from measurement rather than taste:
 *
 *  - **A clip materialises.** It becomes a real quote or a real PNG in the vault, not a
 *    pointer into a file that might move. 174 of 348 PDF page references in this vault's
 *    Excalidraw drawings are already broken because the PDF they named no longer exists
 *    anywhere on the machine. A pointer is not storage.
 *  - **The locator never reaches the note.** `![[deck.pdf#page=12&rect=94,220,510,392]]` is
 *    unreadable in Live Preview, so provenance lives in the `.reader` sidecar keyed by clip
 *    id, and the note gets a plain image embed or a plain quote.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { TextQuoteSelector } from "../core/types";

export type SurfaceKind = "pdf-page" | "video-frame" | "epub-section" | "html-article";

/**
 * Anything you can point at.
 *
 * `index` is a page number for a PDF, a spine index for an EPUB, and 0 for a continuous
 * surface such as an article. Continuous surfaces are why key 3 — "clip the whole surface" —
 * has no meaning everywhere and reports that rather than inventing one.
 */
export interface Surface {
	kind: SurfaceKind;
	index: number;
}

/**
 * Normalised rectangle within a surface: `[x, y, width, height]`, each 0–1.
 *
 * Normalised rather than pixels so a clip survives a zoom change, a window resize and a
 * different device. Storing screen pixels would make every clip wrong the moment the reader
 * is opened at another size.
 */
export type NormalisedRect = readonly [x: number, y: number, width: number, height: number];

/** Where a clip came from. Lives in `.reader`. Never rendered into the note. */
export interface Locator {
	surface: Surface;
	rect?: NormalisedRect;
	/** Seconds into a video. */
	time?: number;
	quote?: TextQuoteSelector;
	/** EPUB canonical fragment identifier. */
	cfi?: string;
}

export type ClipKind = "quote" | "image";

export interface Clip {
	/** ULID. Becomes the `^hl-…` block id, so it is generated once and never recomputed. */
	id: string;
	/** The `.reader` document this clip belongs to. */
	documentId: string;
	kind: ClipKind;
	/** ISO 8601. */
	created: string;
	/** `kind: "quote"` — the text itself, which is what makes the note citable. */
	text?: string;
	/** `kind: "image"` — vault-relative path to the PNG. */
	assetPath?: string;
	/**
	 * A parent: clips after it, up to the next parent, nest beneath it.
	 *
	 * Scope runs by *position*, not by page. In a prose PDF a section's material often starts
	 * partway down the page before it, and ends partway down the page after — so "the parent
	 * on this page" is the wrong rule and "the last parent before this point" is the right one.
	 */
	isParent?: boolean;
	locator: Locator;
}

/**
 * What the view emits. It knows nothing about notes, files or ids.
 *
 * This is the seam that keeps the risky code safe: rendering, hit-testing and rect maths
 * produce a request, and a coordinator turns it into a `Clip`. Nothing in the view layer
 * writes to the vault, so a bug in the renderer cannot corrupt a note.
 */
export interface CaptureRequest {
	kind: ClipKind;
	locator: Locator;
	/** `kind: "quote"`. */
	text?: string;
	/** `kind: "image"` — raw PNG bytes, already rasterised by the surface. */
	png?: Uint8Array;
	/** Mark this clip as a parent for everything that follows it. */
	isParent?: boolean;
}

export interface CaptureSink {
	capture(request: CaptureRequest): Promise<Clip>;
}
