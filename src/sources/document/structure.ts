/**
 * Section detection for prose documents.
 *
 * A workshop handout's structure is its own headings, not its page breaks. This walks the
 * lines of the whole document — pages concatenated — and splits them where a heading appears,
 * so the note mirrors how the document is actually organised.
 *
 * Headings are found by relative font size. A handout sets its body at one size and its
 * headings visibly larger; that is the only signal available from extracted text, and it is a
 * reliable one because it is the same signal a reader uses.
 *
 * Pure — see PLAN.md §3.1.
 */

import { linesToText, type Line } from "../slides/layout";

export interface Section {
	/** 1-based order in the document. */
	index: number;
	heading?: string;
	/** Page the section starts on, for the PDF embed. */
	page: number;
	body: string;
	/** Heading depth, 1 being the largest size in the document. */
	level: number;
}

export interface DocumentLine extends Line {
	page: number;
}

/** A line must exceed the body size by this much to be a heading. */
const HEADING_RATIO = 1.12;

/** Headings are short. A long line at heading size is a pull quote or a title page. */
const MAX_HEADING_LENGTH = 100;

/** Space above a heading, as a multiple of ordinary line leading. */
const HEADING_GAP_RATIO = 1.5;

/** Median vertical distance between consecutive lines on a page — the body leading. */
function medianLeading(lines: readonly DocumentLine[]): number {
	const gaps: number[] = [];
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].page !== lines[i - 1].page) continue;
		const gap = lines[i - 1].y - lines[i].y;
		if (gap > 0) gaps.push(gap);
	}
	if (gaps.length === 0) return 0;
	gaps.sort((a, b) => a - b);
	return gaps[Math.floor(gaps.length / 2)];
}

function modeSize(lines: readonly DocumentLine[]): number {
	// The body size is whichever size the most lines are set in — not the mean, which a few
	// large headings would drag upwards.
	const counts = new Map<number, number>();
	for (const line of lines) {
		const key = Math.round(line.size * 2) / 2;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let best = 0;
	let bestCount = -1;
	for (const [size, count] of counts) {
		// Ties break towards the smaller size: body text is never the larger of two equally
		// common sizes, and keeping the first-seen size instead let a heading become the
		// baseline, which then made every real heading invisible.
		if (count > bestCount || (count === bestCount && size < best)) {
			best = size;
			bestCount = count;
		}
	}
	return best;
}

function isHeading(line: DocumentLine, bodySize: number): boolean {
	const text = line.text.trim();
	if (text === "" || text.length > MAX_HEADING_LENGTH) return false;
	if (!/[A-Za-z]/.test(text)) return false;
	return line.size >= bodySize * HEADING_RATIO;
}

/** Decoration a handout uses to separate sections — `####…`, bullets, numbering. */
const DECORATION = /^\s*([#=*_~>-]{2,}|[-•▪◦*·‣]\s|\d+[.)]\s)/;

/**
 * Notation that means a line is content, not a heading.
 *
 * A regex handout is full of short, well-spaced lines like `[abc] matches a, b or c` and
 * `{n} = match n times`. They sit in a reference table and look exactly like headings by
 * every other measure. Prose headings essentially never contain brackets, pipes, backslashes
 * or an equals sign, so their presence is a reliable veto.
 */
const NOTATION = /[[\]{}|\\=<>`$^]|\s\*/;

/**
 * Fallback for documents typeset entirely at one size.
 *
 * Two of five real workshop handouts set every line in the same font, so the size rule found
 * no headings at all and produced one section containing the whole document. Where size says
 * nothing, shape does: a short line that introduces a longer one, carrying no sentence-ending
 * punctuation, is doing a heading's job. A question mark is allowed — handout headings are
 * frequently questions ("How do I use regex in grep?").
 */
function looksLikeHeading(
	line: DocumentLine,
	next: DocumentLine | undefined,
	gapAbove: number,
	leading: number,
): boolean {
	const text = line.text.trim();
	if (text === "" || text.length > 70) return false;
	if (!/[A-Za-z]/.test(text)) return false;
	if (DECORATION.test(text)) return false;
	if (NOTATION.test(text)) return false;
	// A shell command reads as a heading by every other measure: short, spaced, no full stop.
	if (/\/[^\s]*\//.test(text)) return false;
	if (/^[a-z][a-z0-9_.-]*\s+['"-]/.test(text)) return false;
	if (/[.,;:]$/.test(text)) return false;

	// Something has to follow it, and be longer, or this is just a short paragraph.
	if (next === undefined || next.text.trim().length <= text.length) return false;

	/*
	 * The decisive signal: space above.
	 *
	 * Extracted "lines" are visual lines, so the last line of any paragraph is short and is
	 * followed by a longer one. Without this the rule fired constantly — 35 sections across
	 * five pages of a real handout. A heading is set apart by whitespace; a paragraph's last
	 * line is not.
	 */
	return gapAbove > leading * HEADING_GAP_RATIO;
}

/**
 * Map distinct heading sizes onto markdown depths, largest first.
 *
 * Capped at three: a note whose outline goes six deep is harder to navigate than one that
 * flattens the rare fourth level.
 */
function levelsFor(sizes: readonly number[]): Map<number, number> {
	const distinct = [...new Set(sizes.map((s) => Math.round(s * 2) / 2))].sort((a, b) => b - a);
	const levels = new Map<number, number>();
	distinct.forEach((size, i) => levels.set(size, Math.min(i + 1, 3)));
	return levels;
}

export function buildSections(pages: readonly Line[][]): Section[] {
	const lines: DocumentLine[] = [];
	pages.forEach((page, i) => {
		for (const line of page) lines.push({ ...line, page: i + 1 });
	});

	if (lines.length === 0) return [];

	const bodySize = modeSize(lines);

	/*
	 * Pick the signal that actually works for this document. Font size is the better one when
	 * the typesetting offers it; when it does not, shape is all there is. Deciding once for
	 * the whole document keeps the outline consistent rather than mixing two rules.
	 */
	const leading = medianLeading(lines);
	const gapAbove = (i: number): number =>
		i === 0 || lines[i].page !== lines[i - 1].page ? Number.POSITIVE_INFINITY : lines[i - 1].y - lines[i].y;

	// Any size-based heading at all means the document distinguishes them typographically,
	// and that signal is better than the shape fallback wherever it exists. Requiring two of
	// them meant a document with a single heading fell through and lost it.
	const bySize = lines.filter((line) => isHeading(line, bodySize));
	const useSize = bySize.length >= 1;
	const headingAt = (i: number): boolean =>
		useSize
			? isHeading(lines[i], bodySize)
			: looksLikeHeading(lines[i], lines[i + 1], gapAbove(i), leading);

	const headingLines = useSize ? bySize : lines.filter((_, i) => headingAt(i));
	const levels = levelsFor(headingLines.map((line) => line.size));

	const sections: Section[] = [];
	let current: { heading?: string; page: number; level: number; body: DocumentLine[] } | null = null;

	const flush = (): void => {
		if (!current) return;
		const body = linesToText(current.body);
		// A heading with nothing under it is still worth keeping — it is a section the reader
		// may want to write beneath.
		if (current.heading !== undefined || body !== "") {
			sections.push({
				index: sections.length + 1,
				heading: current.heading,
				page: current.page,
				body,
				level: current.level,
			});
		}
		current = null;
	};

	for (const [i, line] of lines.entries()) {
		if (headingAt(i)) {
			flush();
			current = {
				heading: line.text.trim(),
				page: line.page,
				level: levels.get(Math.round(line.size * 2) / 2) ?? 1,
				body: [],
			};
			continue;
		}

		if (!current) current = { page: line.page, level: 1, body: [] };
		current.body.push(line);
	}
	flush();

	return sections;
}

export interface DocumentOutline {
	sections: Section[];
	title?: string;
	headings: number;
}

export function outlineOf(sections: readonly Section[]): DocumentOutline {
	const first = sections.find((s) => s.heading);
	return {
		sections: [...sections],
		title: first?.heading,
		headings: sections.filter((s) => s.heading).length,
	};
}
