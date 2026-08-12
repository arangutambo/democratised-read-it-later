/**
 * W3C TextQuoteSelector construction and exact matching.
 *
 * The vocabulary is the W3C Web Annotation model's, so the same records can later be
 * exported to or imported from Hypothesis without a translation layer.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

import type { TextQuoteSelector } from "../core/types";

/** Characters of context kept either side of a quote, matching the Books importer. */
export const CONTEXT_LENGTH = 32;

export interface Normalised {
	text: string;
	/** `map[i]` is the index in the original string of normalised character `i`. */
	map: number[];
}

/**
 * Typographic characters that mean the same thing as their ASCII equivalents.
 *
 * This matters more than it looks. EPUB text uses ’ “ ” — and 1,140 of the 1,177 real
 * highlights come from EPUBs — while text extracted from a PDF or scraped from a web page
 * routinely uses ' " -. Without folding, a quote that is character-for-character correct
 * fails to match across formats and lands in the orphan queue for no reason.
 */
const PUNCTUATION_FOLD: Record<string, string> = {
	"‘": "'", "’": "'", "‚": "'", "‛": "'",
	"“": '"', "”": '"', "„": '"', "‟": '"',
	"‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-",
	"−": "-", " ": " ", " ": " ", " ": " ", " ": " ",
	"…": "...",
};

function foldChar(char: string): string {
	return PUNCTUATION_FOLD[char] ?? char;
}

/**
 * Collapse whitespace runs and fold typographic punctuation, keeping an index map back to
 * the original string so a match can be reported in the caller's coordinates.
 */
export function normalise(input: string): Normalised {
	let text = "";
	const map: number[] = [];
	let inWhitespace = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		if (/\s/.test(char)) {
			if (!inWhitespace) {
				text += " ";
				map.push(i);
				inWhitespace = true;
			}
			continue;
		}

		inWhitespace = false;
		const folded = foldChar(char);
		for (const _ of folded) map.push(i);
		text += folded;
	}

	return { text, map };
}

/** Every index in `haystack` where `needle` occurs. */
export function findAll(haystack: string, needle: string): number[] {
	if (needle === "") return [];
	const found: number[] = [];
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) return found;
		found.push(index);
		from = index + 1;
	}
}

function commonSuffixLength(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

function commonPrefixLength(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/**
 * How well the text around `start` agrees with the selector's recorded context, 0–1.
 *
 * This is the whole reason prefix and suffix are stored. "however" appears forty times in a
 * paper; `exact` alone cannot say which one, and ~32 characters either side can.
 */
export function contextScore(
	doc: string,
	start: number,
	length: number,
	selector: TextQuoteSelector,
): number {
	const { prefix, suffix } = selector;
	const available = prefix.length + suffix.length;
	if (available === 0) return 0;

	const before = doc.slice(Math.max(0, start - prefix.length), start);
	const after = doc.slice(start + length, start + length + suffix.length);

	return (commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix)) / available;
}

export interface Candidate {
	start: number;
	score: number;
}

/**
 * Choose among identical occurrences using context, then proximity to a positional hint.
 *
 * Ties are broken by the hint rather than by document order, because for a repeated phrase
 * the nearest occurrence to where it used to be is a far better guess than the first one.
 */
export function pickCandidate(
	doc: string,
	starts: readonly number[],
	length: number,
	selector: TextQuoteSelector,
	hint?: number,
): Candidate | null {
	if (starts.length === 0) return null;
	if (starts.length === 1) {
		return { start: starts[0], score: contextScore(doc, starts[0], length, selector) };
	}

	let best: Candidate | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const start of starts) {
		const score = contextScore(doc, start, length, selector);
		const distance = hint === undefined ? 0 : Math.abs(start - hint);

		if (best === null || score > best.score || (score === best.score && distance < bestDistance)) {
			best = { start, score };
			bestDistance = distance;
		}
	}

	return best;
}

/**
 * Build a selector for the range `[start, end)` of `doc` — the inverse of resolution, used
 * when a highlight is created rather than re-found.
 */
export function describeQuote(
	doc: string,
	start: number,
	end: number,
	contextLength = CONTEXT_LENGTH,
): TextQuoteSelector {
	return {
		exact: doc.slice(start, end),
		prefix: doc.slice(Math.max(0, start - contextLength), start),
		suffix: doc.slice(end, end + contextLength),
	};
}
