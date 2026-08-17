/**
 * Reconstructing a quote's shape from the text layer.
 *
 * `selection.toString()` is the obvious source and the wrong one. The text layer is
 * absolutely positioned, so DOM order is content-stream order, not reading order — selecting
 * a slide heading also picked up a caption from the far corner, because that span happened to
 * sit between them in the markup. It also throws away every line break, so a bulleted slide
 * arrived as one run of prose with the bullet glyphs embedded in it, and words that wrapped
 * came out joined: `ofrelations`, `ifthe`, `modelparameters`.
 *
 * Working from the spans themselves keeps the geometry, and the geometry is the structure:
 * a shared vertical position is a line, a larger left edge is an indent, and a leading glyph
 * is a bullet.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { TextSpan } from "../surface/pdf";

/** Spans whose vertical centres are within this fraction of page height are one line. */
const SAME_LINE = 0.006;

/**
 * Left edges closer together than this are the same indent level.
 *
 * Levels are *ranked*, not divided: a deck indents by whatever its template chose, and
 * dividing by a fixed step turned a single 0.05 indent into two markdown levels. What matters
 * is the order of the distinct left edges on the page, not the distance between them.
 */
const INDENT_TOLERANCE = 0.02;

/** Leading glyphs that mean "this is a list item" rather than part of the sentence. */
const BULLET_GLYPH = /^\s*([•▪‣◦·–—*]|-\s)\s*/;

/** "1." "2)" "iv." "a)" — a numbered item, whose marker is worth keeping verbatim. */
const NUMBERED = /^\s*((?:\d{1,3}|[ivxlIVXL]{1,5}|[a-zA-Z])[.)])\s+/;

export interface QuoteLine {
	text: string;
	/** 0 for the leftmost run of text, 1 for the first indent step, and so on. */
	indent: number;
	/** The list marker, if this line began with one. `•` becomes `-`; `2.` stays `2.`. */
	marker?: string;
}

/**
 * Group spans into lines, in reading order.
 *
 * Sorting is by vertical position and then horizontal, which is what makes the result
 * independent of the order pdf.js happened to emit the runs in.
 */
export function linesFromSpans(spans: readonly TextSpan[]): QuoteLine[] {
	const usable = spans.filter((s) => s.text.trim() !== "");
	if (usable.length === 0) return [];

	const sorted = [...usable].sort((a, b) => {
		const centreA = a.top + a.height / 2;
		const centreB = b.top + b.height / 2;
		if (Math.abs(centreA - centreB) > SAME_LINE) return centreA - centreB;
		return a.left - b.left;
	});

	const rows: TextSpan[][] = [];
	for (const span of sorted) {
		const row = rows[rows.length - 1];
		const centre = span.top + span.height / 2;
		const rowCentre = row ? row[0].top + row[0].height / 2 : Number.NaN;

		if (row && Math.abs(centre - rowCentre) <= SAME_LINE) row.push(span);
		else rows.push([span]);
	}

	const lefts = rows.map((row) => Math.min(...row.map((s) => s.left)));
	const levels = rankIndents(lefts);

	return rows.map((row, i) => {
		const joined = joinRun(row);
		const { text, marker } = takeMarker(joined);
		return { text, indent: levels[i], ...(marker ? { marker } : {}) };
	});
}

/** Distinct left edges, in order, as levels 0, 1, 2… */
function rankIndents(lefts: readonly number[]): number[] {
	const distinct: number[] = [];
	for (const left of [...lefts].sort((a, b) => a - b)) {
		if (distinct.length === 0 || left - distinct[distinct.length - 1] > INDENT_TOLERANCE) {
			distinct.push(left);
		}
	}

	return lefts.map((left) => {
		let level = 0;
		for (let i = 0; i < distinct.length; i++) {
			if (left >= distinct[i] - INDENT_TOLERANCE) level = i;
		}
		return level;
	});
}

/**
 * Join the runs on one line.
 *
 * pdf.js splits a line wherever the font or spacing changes, so a run boundary is usually
 * mid-word — `algorithm` + `s`. A space is inserted only where the geometry says there is a
 * gap, which is what stops `model` + `parameters` becoming `model parameters` when the PDF
 * meant one word, and equally what stops it becoming `modelparameters` when it meant two.
 */
function joinRun(row: readonly TextSpan[]): string {
	let out = "";
	let previousRight: number | undefined;

	for (const span of row) {
		if (previousRight !== undefined) {
			const gap = span.left - previousRight;
			// A gap of about a quarter of the text height is a space; less is kerning.
			const threshold = span.height * 0.12;
			const needsSpace = gap > threshold && !/\s$/.test(out) && !/^\s/.test(span.text);
			if (needsSpace) out += " ";
		}
		out += span.text;
		previousRight = span.left + span.width;
	}

	return out.replace(/\s+/g, " ").trim();
}

function takeMarker(line: string): { text: string; marker?: string } {
	const numbered = NUMBERED.exec(line);
	if (numbered) return { text: line.slice(numbered[0].length), marker: numbered[1] };

	const bullet = BULLET_GLYPH.exec(line);
	if (bullet) return { text: line.slice(bullet[0].length), marker: "-" };

	return { text: line };
}

/**
 * Lines into one quotable string.
 *
 * A word broken across a line ends in a hyphen, and rejoining it is not optional: the
 * alternative is `converg- ence` in the note. A hyphen that ends a line *and* is followed by
 * a lowercase letter is hyphenation; one followed by a capital or a digit is a real compound
 * or a range, and stays.
 */
export function joinLines(lines: readonly QuoteLine[]): string {
	let out = "";

	for (const line of lines) {
		if (out === "") {
			out = line.text;
			continue;
		}
		if (/[‐-―-]$/.test(out) && /^[a-z]/.test(line.text)) {
			out = out.replace(/[‐-―-]$/, "") + line.text;
		} else {
			out += ` ${line.text}`;
		}
	}

	return out.replace(/\s+/g, " ").trim();
}

/**
 * Lines as markdown, keeping the list structure the slide had.
 *
 * Returns a single string that may contain newlines. The caller decides how to fit it into a
 * bullet — see `note/bullet.ts`, which prefixes continuation lines so the whole thing stays
 * one list item.
 */
export function renderStructured(lines: readonly QuoteLine[]): string {
	if (lines.length === 0) return "";

	// Nothing has a marker: this is prose that merely wrapped, so rejoin it into a sentence
	// rather than preserving line breaks that were a typesetting accident.
	if (!lines.some((l) => l.marker)) return joinLines(lines);

	const out: string[] = [];
	let carry: QuoteLine | undefined;

	for (const line of lines) {
		if (line.marker) {
			if (carry) out.push(renderLine(carry));
			carry = { ...line };
		} else if (carry) {
			// A wrapped continuation of the item above.
			carry = { ...carry, text: joinLines([carry, line]) };
		} else {
			out.push(renderLine(line));
		}
	}
	if (carry) out.push(renderLine(carry));

	return out.join("\n");
}

function renderLine(line: QuoteLine): string {
	const pad = "  ".repeat(line.indent);
	return line.marker ? `${pad}${line.marker} ${line.text}` : `${pad}${line.text}`;
}
