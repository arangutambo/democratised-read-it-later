/**
 * What the view is allowed to know about a document.
 *
 * The view drives this and nothing else, so the three keys, the overlay and the note writing
 * are written once rather than once per source type. A PDF page, a video frame, an EPUB
 * section and an article are all "a thing with a size that you can render, crop and select
 * text from" — see SOURCES.md §2.
 *
 * Kept deliberately small. It is easy to grow an interface until only one implementation can
 * satisfy it, at which point it is no longer an interface. Everything specific to PDFs —
 * outlines, page labels, text-layer positioning — stays on `PdfSurface` and is reached by the
 * PDF-specific parts of the view.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { NormalisedRect, SurfaceKind } from "../../capture/types";

export interface SurfaceSize {
	width: number;
	height: number;
}

export interface DocumentSurfaces {
	readonly kind: SurfaceKind;

	/**
	 * How many surfaces there are: pages, spine sections, or 1 for a continuous document.
	 *
	 * A continuous surface is why key 3 does not mean the same thing everywhere. It reports
	 * that rather than inventing a meaning — a multi-megabyte PNG of a whole chapter is not a
	 * clip, and neither is a screenshot of whatever the window happened to be showing.
	 */
	readonly count: number;

	/** True when "the whole surface" is a thing a clip can be. False for a continuous one. */
	readonly wholeSurfaceIsClippable: boolean;

	/** Intrinsic size, in whatever unit the source uses. PDFs use points. */
	size(index: number): Promise<SurfaceSize>;

	/** PNG bytes for a normalised region of a surface. */
	renderRegion(
		index: number,
		rect: NormalisedRect,
		dpi: number,
		signal?: AbortSignal,
	): Promise<Uint8Array>;

	close(): Promise<void>;
}
