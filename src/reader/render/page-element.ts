/**
 * One page on screen: a canvas, a selectable text layer over it, and the marks.
 *
 * Three stacked layers, in this order, and the order is load-bearing:
 *
 *   canvas   the rendered page
 *   overlay  the marks — `pointer-events: none`, or it eats the selection
 *   text     transparent, selectable, on top so the browser hit-tests it
 *
 * The text layer is transparent rather than absent because selection has to come from the
 * browser: reimplementing hit-testing and multi-line selection over a canvas is a project in
 * itself, and this way copy, double-click-to-select-word and shift-click all work for free.
 */

import type { NormalisedRect } from "../../capture/types";
import type { TextSpan } from "../surface/pdf";
import { toScreen } from "../gesture/region";

export interface PageElement {
	root: HTMLElement;
	canvasHost: HTMLElement;
	textLayer: HTMLElement;
	overlay: HTMLElement;
	/** Every text span's text, joined — the haystack a quote selector's context comes from. */
	text: string;
}

export function createPageElement(pageNumber: number): PageElement {
	const root = document.createElement("div");
	root.className = "reader-page";
	root.dataset.page = String(pageNumber);

	const canvasHost = document.createElement("div");
	canvasHost.className = "reader-page-canvas";

	const overlay = document.createElement("div");
	overlay.className = "reader-page-overlay";

	const textLayer = document.createElement("div");
	textLayer.className = "reader-page-text";

	root.append(canvasHost, overlay, textLayer);
	return { root, canvasHost, textLayer, overlay, text: "" };
}

/** Put a freshly rendered canvas into the page, replacing any previous one. */
export function setCanvas(page: PageElement, canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): void {
	canvas.style.width = `${cssWidth}px`;
	canvas.style.height = `${cssHeight}px`;

	page.root.style.width = `${cssWidth}px`;
	page.root.style.height = `${cssHeight}px`;

	page.canvasHost.replaceChildren(canvas);
}

/**
 * Drop a page's heavy content while keeping its box, so the scroll position does not jump.
 *
 * The canvas is explicitly zeroed rather than merely detached: that is what releases the
 * backing store promptly in Chromium, and on a fast scroll through a 315-page workbook the
 * garbage collector is far too late.
 */
export function releaseCanvas(page: PageElement): void {
	for (const canvas of Array.from(page.canvasHost.querySelectorAll("canvas"))) {
		canvas.width = 0;
		canvas.height = 0;
	}
	page.canvasHost.replaceChildren();
	page.textLayer.replaceChildren();
	page.text = "";
}

/**
 * Lay out the selectable text.
 *
 * Spans are positioned in percentages so the layer stays correct when the page is re-rendered
 * at a different width without rebuilding it. Font size is derived from the span's own height
 * so that selection highlights sit roughly over the glyphs; exact glyph-width matching is a
 * refinement for later — the *captured text* is taken from the span's textContent, so it is
 * already exact regardless of how well the boxes line up.
 */
export function setTextLayer(page: PageElement, spans: TextSpan[], cssHeight: number): void {
	const fragment = document.createDocumentFragment();
	const parts: string[] = [];

	for (const span of spans) {
		const el = document.createElement("span");
		el.textContent = span.text;
		el.style.left = `${span.left * 100}%`;
		el.style.top = `${span.top * 100}%`;
		el.style.fontSize = `${Math.max(1, span.height * cssHeight)}px`;
		fragment.append(el);
		parts.push(span.text);
	}

	page.textLayer.replaceChildren(fragment);
	// Joined with spaces: this is the haystack for a quote's prefix and suffix, and pdf.js
	// emits one item per run rather than per word.
	page.text = parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Draw the marks for this page. Replaces whatever was there. */
export function setMarks(page: PageElement, rects: readonly NormalisedRect[]): void {
	const fragment = document.createDocumentFragment();

	for (const rect of rects) {
		const box = toScreen(rect, 100, 100);
		const el = document.createElement("div");
		el.className = "reader-mark";
		// Percentages, so marks stay put across a re-render at a different zoom.
		el.style.left = `${box.x}%`;
		el.style.top = `${box.y}%`;
		el.style.width = `${box.width}%`;
		el.style.height = `${box.height}%`;
		fragment.append(el);
	}

	page.overlay.replaceChildren(fragment);
}
