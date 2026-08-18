/**
 * Turning a DOM selection over the text layer into something storable.
 *
 * Two things come out of a selection and both are kept:
 *
 *  - a **W3C TextQuoteSelector** — exact text plus surrounding context — which is what
 *    survives the document being re-exported with different pagination. This is the vocabulary
 *    `src/anchor/*` already resolves at 0% mis-anchoring across 1,176 real highlights.
 *  - a **bounding rect**, so the mark can be drawn back onto the page immediately without
 *    re-running the anchoring ladder on every scroll.
 *
 * The rect is the fast path and the quote is the durable one. Keeping only the rect would
 * break the moment the PDF is replaced by an updated edition; keeping only the quote would
 * mean resolving 40 highlights against a text layer every time a page scrolls into view.
 */

import type { TextQuoteSelector } from "../../core/types";
import type { NormalisedRect } from "../../capture/types";
import { toNormalised, type Box } from "./region";
import { runBetween } from "./columns";
import { linesFromSpans, renderStructured } from "./structure";
import type { TextSpan } from "../surface/pdf";

/** Characters of context each side. Enough to disambiguate a word that recurs on a page. */
const CONTEXT = 32;

export interface CapturedSelection {
	text: string;
	quote: TextQuoteSelector;
	rect: NormalisedRect;
}

/**
 * The union of a selection's client rects, in the page element's coordinate space.
 *
 * `getBoundingClientRect()` on the range is not used: a selection spanning two lines returns
 * a box covering everything between them, including the full width of the page. The union of
 * the individual rects is still a single box, but one that starts and ends where the text
 * does.
 */
export function selectionBox(range: Range, pageRect: DOMRect): Box | undefined {
	const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
	if (rects.length === 0) return undefined;

	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;

	for (const rect of rects) {
		left = Math.min(left, rect.left);
		top = Math.min(top, rect.top);
		right = Math.max(right, rect.right);
		bottom = Math.max(bottom, rect.bottom);
	}

	return {
		x: left - pageRect.left,
		y: top - pageRect.top,
		width: right - left,
		height: bottom - top,
	};
}

/**
 * Prefix and suffix around the selection, taken from the page's own text.
 *
 * `exact` alone cannot place a quote — "however" appears forty times in a paper — which is
 * why prefix and suffix are required fields rather than optional ones.
 */
export function quoteSelectorFor(
	pageText: string,
	exact: string,
	/** Where the selection starts in `pageText`, when the caller knows. */
	hint?: number,
): TextQuoteSelector {
	const at = hint !== undefined && hint >= 0 ? hint : pageText.indexOf(exact);
	if (at < 0) return { exact, prefix: "", suffix: "" };

	return {
		prefix: pageText.slice(Math.max(0, at - CONTEXT), at),
		exact,
		suffix: pageText.slice(at + exact.length, at + exact.length + CONTEXT),
	};
}

/**
 * Capture the current selection, if it lies within `pageEl`.
 *
 * Returns undefined for an empty or collapsed selection, and for a selection that has
 * wandered outside the page — a drag that started on the page and ended in the note should
 * not silently clip half a document.
 */
/** Where a range begins or ends, in the page's own normalised coordinates. */
function pointOf(range: Range, start: boolean, pageRect: DOMRect): { x: number; y: number } {
	const edge = range.cloneRange();
	edge.collapse(start);

	const rect = edge.getBoundingClientRect();
	return {
		x: (rect.left - pageRect.left) / Math.max(1, pageRect.width),
		y: (rect.top - pageRect.top) / Math.max(1, pageRect.height),
	};
}

export function captureSelection(
	selection: Selection | null,
	pageEl: HTMLElement,
	pageText: string,
	/** The page's spans, so the quote can be rebuilt from geometry rather than DOM order. */
	spans: readonly TextSpan[] = [],
): CapturedSelection | undefined {
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;

	const range = selection.getRangeAt(0);
	if (!pageEl.contains(range.commonAncestorContainer)) return undefined;

	const pageRect = pageEl.getBoundingClientRect();

	/*
	 * Which spans the selection actually covers, by index.
	 *
	 * `selection.toString()` walks the DOM, and the text layer is absolutely positioned — so a
	 * selection between two visually adjacent runs swept up everything that happened to sit
	 * between them in the markup. Selecting a slide heading picked up "Test metrics" from the
	 * far corner of the page, and the mark drawn from the range's rects covered both.
	 */
	const covered: TextSpan[] = [];
	const elements = pageEl.querySelectorAll(".reader-page-text > span");
	elements.forEach((el, index) => {
		if (!selection.containsNode(el, true)) return;
		const span = spans[index];
		if (span) covered.push(span);
	});

	/*
	 * Cut that down to what a person would call the selection.
	 *
	 * `containsNode` is DOM order, and on a two-column page the DOM zigzags: body text and a
	 * figure caption sit at the same height, so dragging over one sentence swept up fragments
	 * from all over the page and drew a mark on each. Taking the run between where the drag
	 * started and where it ended, in reading order, is what the gesture actually meant.
	 */
	const between = runBetween(spans, pointOf(range, true, pageRect), pointOf(range, false, pageRect));
	if (between.length > 0 && between.length < covered.length) {
		const wanted = new Set(between);
		const trimmed = covered.filter((span) => wanted.has(span));
		if (trimmed.length > 0) {
			covered.length = 0;
			covered.push(...trimmed);
		}
	}

	const structured = covered.length > 0 ? renderStructured(linesFromSpans(covered)) : "";
	// Fall back to the raw selection when the spans could not be matched — a quote that is
	// merely unstructured beats refusing to capture the words at all.
	const text = structured !== "" ? structured : selection.toString().replace(/\s+/g, " ").trim();
	if (text.trim() === "") return undefined;

	const box = coveredBox(covered, pageRect) ?? selectionBox(range, pageRect);
	if (!box) return undefined;

	// The selector matches on one line of text, so it uses the flattened form even when the
	// quote itself keeps its list structure.
	const flat = text.replace(/\s+/g, " ").trim();

	return {
		text,
		quote: quoteSelectorFor(pageText, flat),
		rect: toNormalised(box, pageRect.width, pageRect.height),
	};
}

/** The box around exactly the spans covered, in the page element's coordinate space. */
function coveredBox(spans: readonly TextSpan[], pageRect: DOMRect): Box | undefined {
	if (spans.length === 0) return undefined;

	const left = Math.min(...spans.map((s) => s.left));
	const top = Math.min(...spans.map((s) => s.top));
	const right = Math.max(...spans.map((s) => s.left + s.width));
	const bottom = Math.max(...spans.map((s) => s.top + s.height));

	return {
		x: left * pageRect.width,
		y: top * pageRect.height,
		width: (right - left) * pageRect.width,
		height: (bottom - top) * pageRect.height,
	};
}
