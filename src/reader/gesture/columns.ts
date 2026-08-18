/**
 * Reading order on a page that has columns.
 *
 * pdf.js hands over text in content-stream order, which is the order the file happens to draw
 * glyphs in and not the order anyone reads them. On a single-column page the two mostly agree.
 * On a two-column textbook page they do not: body text and a figure caption sit at the same
 * height, so sorting by y interleaves them, and a browser selection between two visually
 * adjacent runs sweeps up everything lying between them in the markup — which is how selecting
 * one sentence highlighted fragments scattered over the whole page.
 *
 * So reading order is reconstructed from geometry: find the columns, then read each one down.
 * That is the same first step the PDF layout-analysis toolkits take; theirs is a trained model
 * over a rendered page, this is the cheap version that works because a text layer already
 * knows where every run sits.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { TextSpan } from "../surface/pdf";

/**
 * A gutter has to be this wide, as a fraction of page width, to split a column.
 *
 * Wide enough that the space between words or a hanging indent never counts, narrow enough to
 * catch a real two-column layout. Textbook gutters run 3–6% of the page.
 */
const MIN_GUTTER = 0.02;

/** Rows within this fraction of each other are the same line. */
const SAME_LINE = 0.006;

/** Column boundaries as x positions, left to right. Empty when the page is one column. */
export function detectColumns(spans: readonly TextSpan[]): number[] {
	const usable = spans.filter((s) => s.text.trim() !== "" && s.width > 0);
	if (usable.length < 8) return [];

	/*
	 * Where the page has ink, in 200 vertical slices.
	 *
	 * A gutter is a run of slices no span crosses. Sampling rather than interval arithmetic
	 * because a page has hundreds of spans and this runs on every selection.
	 */
	const SLICES = 200;
	const occupied = new Array<boolean>(SLICES).fill(false);

	for (const span of usable) {
		const from = Math.max(0, Math.floor(span.left * SLICES));
		const to = Math.min(SLICES - 1, Math.ceil((span.left + span.width) * SLICES));
		for (let i = from; i <= to; i++) occupied[i] = true;
	}

	const boundaries: number[] = [];
	let gapStart = -1;

	for (let i = 0; i < SLICES; i++) {
		if (!occupied[i]) {
			if (gapStart === -1) gapStart = i;
			continue;
		}

		if (gapStart > 0 && (i - gapStart) / SLICES >= MIN_GUTTER) {
			// The middle of the gutter, which is where a column ends and the next begins.
			boundaries.push((gapStart + i) / 2 / SLICES);
		}
		gapStart = -1;
	}

	return boundaries;
}

/** Which column a span belongs to, by where its centre falls. */
export function columnOf(span: TextSpan, boundaries: readonly number[]): number {
	const centre = span.left + span.width / 2;
	let column = 0;
	for (const boundary of boundaries) if (centre > boundary) column++;
	return column;
}

/**
 * The spans in the order a person reads them: each column top to bottom, columns left to right.
 */
export function readingOrder(spans: readonly TextSpan[]): TextSpan[] {
	const boundaries = detectColumns(spans);

	return [...spans].sort((a, b) => {
		const columnA = columnOf(a, boundaries);
		const columnB = columnOf(b, boundaries);
		if (columnA !== columnB) return columnA - columnB;

		const centreA = a.top + a.height / 2;
		const centreB = b.top + b.height / 2;
		if (Math.abs(centreA - centreB) > SAME_LINE) return centreA - centreB;

		return a.left - b.left;
	});
}

/** A point on the page, normalised. */
export interface Point {
	x: number;
	y: number;
}

/** The span nearest a point, for turning where you pressed into where you meant. */
export function spanAt(spans: readonly TextSpan[], point: Point): TextSpan | undefined {
	let best: TextSpan | undefined;
	let bestDistance = Infinity;

	for (const span of spans) {
		// Zero inside the span, otherwise the distance to its edge.
		const dx = Math.max(span.left - point.x, 0, point.x - (span.left + span.width));
		const dy = Math.max(span.top - point.y, 0, point.y - (span.top + span.height));
		const distance = dx * dx + dy * dy;

		if (distance < bestDistance) {
			bestDistance = distance;
			best = span;
		}
	}

	return best;
}

/**
 * Everything between two points, in reading order.
 *
 * This is what a selection actually means — "from here to there, as it is read" — rather than
 * "every node the DOM happens to place between these two", which is what the browser gives and
 * what scattered marks across a two-column page.
 */
export function runBetween(spans: readonly TextSpan[], from: Point, to: Point): TextSpan[] {
	const ordered = readingOrder(spans);
	if (ordered.length === 0) return [];

	const start = spanAt(ordered, from);
	const end = spanAt(ordered, to);
	if (!start || !end) return [];

	const a = ordered.indexOf(start);
	const b = ordered.indexOf(end);

	return ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
}
