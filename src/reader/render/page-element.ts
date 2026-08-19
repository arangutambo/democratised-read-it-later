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

import { readingOrder } from "../gesture/columns";
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
	/** The spans as laid out, in the same order as the layer's child elements. */
	spans: TextSpan[];
}

export function createPageElement(pageNumber: number): PageElement {
	const root = createDiv();
	root.className = "reader-page";
	root.dataset.page = String(pageNumber);

	const canvasHost = createDiv();
	canvasHost.className = "reader-page-canvas";

	const overlay = createDiv();
	overlay.className = "reader-page-overlay";

	const textLayer = createDiv();
	textLayer.className = "reader-page-text";

	root.append(canvasHost, overlay, textLayer);
	return { root, canvasHost, textLayer, overlay, text: "", spans: [] };
}

/**
 * Put a freshly rendered canvas into the page, replacing any previous one.
 *
 * The page is sized by **aspect ratio**, never by pixels. Setting an explicit px width and
 * height meant a page that had not been re-rendered kept a stale box after the pane was
 * resized, and everything measured against it — the marks, the text layer — was then wrong
 * until a render caught up. With a ratio, the page always fills the column at whatever width
 * it happens to be, and a re-render only sharpens it.
 */
export function setCanvas(page: PageElement, canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): void {
	if (cssWidth > 0 && cssHeight > 0) page.root.setCssStyles({ aspectRatio: `${cssWidth} / ${cssHeight}` });
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
	page.spans = [];
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
export function setTextLayer(
	page: PageElement,
	unordered: TextSpan[],
	cssWidth: number,
	cssHeight: number,
): void {
	/*
	 * Built in reading order, not in the order pdf.js emits.
	 *
	 * This is what a browser selection follows. The spans are absolutely positioned, so their
	 * DOM order is invisible until you drag across them — and on a two-column page pdf.js's
	 * order zigzags between the body text and the figure caption beside it. The browser then
	 * paints its selection over every span lying between the two in the markup, which is why
	 * selecting one sentence lit up fragments scattered across the whole page.
	 *
	 * Sorting here fixes it at the source: the selection the browser paints, the text
	 * `toString()` returns, and the spans a capture walks are all the same thing again.
	 */
	const spans = readingOrder(unordered);
	const fragment = createFragment();
	const parts: string[] = [];
	const created: { el: HTMLElement; target: number }[] = [];

	for (const span of spans) {
		const el = createSpan();
		el.textContent = span.text;
		el.style.left = `${span.left * 100}%`;
		el.style.top = `${span.top * 100}%`;
		/*
		 * Sized as a fraction of the page's own height, not in pixels.
		 *
		 * `cqh` is 1% of the containing block's height, and `.reader-page` declares itself a
		 * size container. So the layer rescales with the page for free — no re-measure, no
		 * re-render, and no window in which selection lands somewhere the glyphs are not.
		 * The scaleX below is a *ratio* of two lengths that both scale together, so it stays
		 * correct at any size too.
		 */
		el.style.fontSize = `${Math.max(0.1, span.height * 100)}cqh`;

		/*
		 * A zero-width trailing space.
		 *
		 * pdf.js emits one item per run, and adjacent runs on a line carry no whitespace
		 * between them — so a selection across "can" and "type" came out as "cantype". This
		 * puts a real space in the text content, where `selection.toString()` picks it up,
		 * while contributing nothing to layout or to the width measured below. Runs that
		 * already end in a space are left alone; `tidyQuote` collapses any doubling anyway.
		 */
		if (!/\s$/.test(span.text)) {
			const gap = createSpan();
			gap.className = "reader-space";
			gap.textContent = " ";
			el.append(gap);
		}

		fragment.append(el);
		created.push({ el, target: span.width * cssWidth });
		parts.push(span.text);
	}

	page.textLayer.replaceChildren(fragment);
	// Same order as the child elements, so a covered element maps back to its span.
	page.spans = spans;

	/*
	 * Scale each span to the width the PDF gives it.
	 *
	 * The span is rendered in a system font, not the one embedded in the document, so its
	 * natural width is wrong — and the error accumulates along a line, which is why selection
	 * boundaries drifted further from the glyphs the further you dragged. Measuring after the
	 * layer is in the DOM costs one forced reflow per page, which is worth it: this is the
	 * difference between selection that lands where you point and selection that guesses.
	 */
	for (const { el, target } of created) {
		const natural = el.getBoundingClientRect().width;
		if (natural > 0 && target > 0) el.style.transform = `scaleX(${target / natural})`;
	}

	// Joined with spaces: this is the haystack for a quote's prefix and suffix.
	page.text = parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Draw the marks for this page. Replaces whatever was there. */
export function setMarks(page: PageElement, rects: readonly NormalisedRect[]): void {
	const fragment = createFragment();

	for (const rect of rects) {
		const box = toScreen(rect, 100, 100);
		const el = createDiv();
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
