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
export function captureSelection(
	selection: Selection | null,
	pageEl: HTMLElement,
	pageText: string,
): CapturedSelection | undefined {
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;

	const range = selection.getRangeAt(0);
	if (!pageEl.contains(range.commonAncestorContainer)) return undefined;

	const text = selection.toString().replace(/\s+/g, " ").trim();
	if (text === "") return undefined;

	const pageRect = pageEl.getBoundingClientRect();
	const box = selectionBox(range, pageRect);
	if (!box) return undefined;

	return {
		text,
		quote: quoteSelectorFor(pageText, text),
		rect: toNormalised(box, pageRect.width, pageRect.height),
	};
}
