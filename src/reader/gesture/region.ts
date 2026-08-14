/**
 * Rect maths for the box-drag gesture.
 *
 * Pure, and separated from the view for one reason: geometry fails *quietly*. A clip that is
 * off by a scale factor still produces a perfectly valid PNG of the wrong part of the page,
 * and you find out weeks later when you reread the note. So the arithmetic is testable
 * without a canvas, a window, or a running Obsidian.
 *
 * Two coordinate spaces, and the conversion between them is the whole file:
 *
 *   **screen** — CSS pixels within the rendered page element. Depends on zoom and window size.
 *   **normalised** — 0–1 within the page. What gets stored, so a clip survives a zoom change,
 *                    a resize, and a different device.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { NormalisedRect } from "../../capture/types";

export interface Point {
	x: number;
	y: number;
}

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The box between two drag points, in screen pixels.
 *
 * Dragging up-and-left is as normal as down-and-right, so the corners are ordered rather
 * than assumed — without this, half of all drags produce a negative width.
 */
export function boxBetween(from: Point, to: Point): Box {
	return {
		x: Math.min(from.x, to.x),
		y: Math.min(from.y, to.y),
		width: Math.abs(to.x - from.x),
		height: Math.abs(from.y - to.y),
	};
}

/** Screen-pixel box within a rendered page of `pageWidth` × `pageHeight` → normalised. */
export function toNormalised(box: Box, pageWidth: number, pageHeight: number): NormalisedRect {
	if (pageWidth <= 0 || pageHeight <= 0) return [0, 0, 0, 0];
	return [
		box.x / pageWidth,
		box.y / pageHeight,
		box.width / pageWidth,
		box.height / pageHeight,
	];
}

/** Normalised rect → screen-pixel box, for drawing the overlay back onto a rendered page. */
export function toScreen(rect: NormalisedRect, pageWidth: number, pageHeight: number): Box {
	const [x, y, w, h] = rect;
	return {
		x: x * pageWidth,
		y: y * pageHeight,
		width: w * pageWidth,
		height: h * pageHeight,
	};
}

/**
 * A PDF point is 1/72 inch, which is what makes DPI meaningful here: `scale` is simply how
 * many device pixels we want per point.
 */
const POINTS_PER_INCH = 72;

export interface RenderPlan {
	/** Viewport scale to hand pdf.js. */
	scale: number;
	/** Pixel box to crop out of the rendered page, at that scale. */
	crop: Box;
	/** Final image dimensions, both at least 1px. */
	width: number;
	height: number;
}

/**
 * How to render a normalised region of a page at a given DPI.
 *
 * The whole page is rendered at `scale` and the region cropped out of it, rather than
 * rendering the region directly — pdf.js has no "render this rectangle" call, and offsetting
 * the transform by hand is how you get clips that are subtly shifted.
 *
 * `maxPixels` is a guard, not a preference. Canvas costs 4 bytes a pixel, so the default 16
 * megapixels is a 64 MB allocation — already generous, and enough for A4 at 300 DPI or A3 at
 * 200. An A0 conference poster at 150 DPI is 35 megapixels and 140 MB, which on an iPad is
 * not a slow clip but a dead tab. When the guard bites the clip comes out smaller rather
 * than not at all, because a slightly soft figure beats a crashed reader.
 */
export function planRegionRender(
	rect: NormalisedRect,
	pagePoints: { width: number; height: number },
	dpi: number,
	maxPixels = 16_000_000,
): RenderPlan {
	const requested = Math.max(0.1, dpi / POINTS_PER_INCH);

	const fullWidth = pagePoints.width * requested;
	const fullHeight = pagePoints.height * requested;
	const pixels = fullWidth * fullHeight;
	const scale = pixels > maxPixels ? requested * Math.sqrt(maxPixels / pixels) : requested;

	const pageWidth = pagePoints.width * scale;
	const pageHeight = pagePoints.height * scale;
	const crop = toScreen(rect, pageWidth, pageHeight);

	return {
		scale,
		crop,
		// A sub-pixel region would otherwise produce a zero-dimension canvas, which throws.
		width: Math.max(1, Math.round(crop.width)),
		height: Math.max(1, Math.round(crop.height)),
	};
}

/** The whole page, as a region. Key 3 is the same operation with the unit rect. */
export const WHOLE_SURFACE: NormalisedRect = [0, 0, 1, 1];
