/**
 * The resolution ladder: given a document and a highlight's selector, find where the
 * highlight now lives — or declare it orphaned.
 *
 * DESIGN.md §5.1 order, implemented: exact → whitespace/punctuation-normalised → fuzzy →
 * offset → orphaned. CFI and quadpoint anchors are deliberately absent: they address
 * positions in a structured document (an EPUB spine, a PDF page), not in a plain string, so
 * they are resolved by the format-specific reader *before* it falls back to this module.
 *
 * One deliberate deviation from §5.1, called out because it changes behaviour:
 * **a stored character offset is never trusted on its own.** §5.1 lists offset as the last
 * step before orphaning, but a document that has been edited will happily yield a range at
 * that offset pointing at completely unrelated prose. Silently attaching a highlight to the
 * wrong sentence is worse than an orphan, because the user cannot see that it happened. The
 * offset step therefore only succeeds if the text actually found there still resembles the
 * quote; otherwise the highlight is orphaned and shown in the review queue.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

import type { TextQuoteSelector } from "../core/types";
import { editDistance, fuzzyFind, type FuzzyOptions } from "./matcher";
import { contextScore, findAll, normalise, pickCandidate, type Normalised } from "./selector";

export type Strategy = "exact" | "normalised" | "fuzzy" | "offset";

export interface ResolvedAnchor {
	ok: true;
	start: number;
	end: number;
	strategy: Strategy;
	/** Confidence in this placement, 0–1. */
	score: number;
	/** True when the quote occurs more than once and context could not separate them. */
	ambiguous: boolean;
}

export interface OrphanedAnchor {
	ok: false;
	reason: "orphaned";
	/** Which strategies were tried, for the review queue to explain itself. */
	attempted: Strategy[];
}

export type Resolution = ResolvedAnchor | OrphanedAnchor;

export interface ResolveOptions extends FuzzyOptions {
	/** Where the highlight used to be, if known. Used as a search seed and a tiebreaker. */
	hint?: { start: number; end: number };
	/**
	 * Similarity required before a bare offset is believed, 0–1. Deliberately strict: this
	 * is the only step that can place a highlight without having matched its text.
	 */
	offsetSimilarity?: number;
	/**
	 * A pre-computed normalisation of `doc`, shared across a batch.
	 *
	 * Normalising rebuilds the document and a per-character index map, so doing it once per
	 * highlight is O(n·m). Measured on the real corpus that was 130 seconds for a reflowed
	 * document set; hoisting it out of the loop brings it back to seconds. `resolveAll`
	 * supplies this automatically.
	 */
	normalisedDoc?: Normalised;
}

const DEFAULT_OFFSET_SIMILARITY = 0.7;

function resolveExact(doc: string, selector: TextQuoteSelector, hint?: number): Resolution | null {
	const starts = findAll(doc, selector.exact);
	const candidate = pickCandidate(doc, starts, selector.exact.length, selector, hint);
	if (candidate === null) return null;

	return {
		ok: true,
		start: candidate.start,
		end: candidate.start + selector.exact.length,
		strategy: "exact",
		// A single unambiguous occurrence is certain regardless of how much context matched.
		score: starts.length === 1 ? 1 : Math.max(candidate.score, 0.5),
		ambiguous: starts.length > 1 && candidate.score === 0,
	};
}

function resolveNormalised(
	doc: string,
	selector: TextQuoteSelector,
	hint: number | undefined,
	precomputed: Normalised | undefined,
): Resolution | null {
	const normalisedDoc = precomputed ?? normalise(doc);
	const normalisedQuote = normalise(selector.exact).text.trim();
	if (normalisedQuote === "") return null;

	const starts = findAll(normalisedDoc.text, normalisedQuote);
	if (starts.length === 0) return null;

	const normalisedSelector: TextQuoteSelector = {
		exact: normalisedQuote,
		prefix: normalise(selector.prefix).text,
		suffix: normalise(selector.suffix).text,
	};

	// The hint is in original coordinates; translate it into normalised space to compare.
	const normalisedHint =
		hint === undefined ? undefined : normalisedDoc.map.findIndex((original) => original >= hint);

	const candidate = pickCandidate(
		normalisedDoc.text,
		starts,
		normalisedQuote.length,
		normalisedSelector,
		normalisedHint === -1 ? undefined : normalisedHint,
	);
	if (candidate === null) return null;

	const start = normalisedDoc.map[candidate.start];
	const lastIndex = candidate.start + normalisedQuote.length - 1;
	const end = (normalisedDoc.map[lastIndex] ?? doc.length - 1) + 1;

	return {
		ok: true,
		start,
		end,
		strategy: "normalised",
		score: starts.length === 1 ? 0.95 : Math.max(candidate.score, 0.5),
		ambiguous: starts.length > 1 && candidate.score === 0,
	};
}

/**
 * When the quote itself cannot be found but its recorded context can, the context's position
 * is a strong, cheap seed for the fuzzy search — the quote sits immediately after the prefix.
 */
function seedFromContext(doc: string, selector: TextQuoteSelector): number | undefined {
	if (selector.prefix.length >= 8) {
		const at = doc.indexOf(selector.prefix);
		if (at !== -1) return at + selector.prefix.length;
	}
	if (selector.suffix.length >= 8) {
		const at = doc.indexOf(selector.suffix);
		if (at !== -1) return Math.max(0, at - selector.exact.length);
	}
	return undefined;
}

function resolveFuzzy(
	doc: string,
	selector: TextQuoteSelector,
	hint: number | undefined,
	options: ResolveOptions,
): Resolution | null {
	const seed = hint ?? seedFromContext(doc, selector);
	const match = fuzzyFind(doc, selector.exact, seed, options);
	if (match === null) return null;

	// Context is not required, but when it agrees the placement is more trustworthy.
	const context = contextScore(doc, match.start, match.end - match.start, selector);

	return {
		ok: true,
		start: match.start,
		end: match.end,
		strategy: "fuzzy",
		score: Math.min(1, match.score * 0.9 + context * 0.1),
		ambiguous: false,
	};
}

function resolveOffset(doc: string, selector: TextQuoteSelector, options: ResolveOptions): Resolution | null {
	const hint = options.hint;
	if (!hint || hint.start < 0 || hint.start >= doc.length) return null;

	const end = Math.min(doc.length, hint.end);
	if (end <= hint.start) return null;

	const found = doc.slice(hint.start, end);
	const distance = editDistance(selector.exact, found);
	const similarity = 1 - distance / Math.max(selector.exact.length, found.length, 1);

	// The guard that stops a stale offset silently mis-anchoring. See the note at the top.
	if (similarity < (options.offsetSimilarity ?? DEFAULT_OFFSET_SIMILARITY)) return null;

	return { ok: true, start: hint.start, end, strategy: "offset", score: similarity * 0.6, ambiguous: false };
}

export function resolveQuote(
	doc: string,
	selector: TextQuoteSelector,
	options: ResolveOptions = {},
): Resolution {
	const attempted: Strategy[] = [];
	const hint = options.hint?.start;

	if (selector.exact !== "" && doc !== "") {
		attempted.push("exact");
		const exact = resolveExact(doc, selector, hint);
		if (exact) return exact;

		attempted.push("normalised");
		const normalised = resolveNormalised(doc, selector, hint, options.normalisedDoc);
		if (normalised) return normalised;

		attempted.push("fuzzy");
		const fuzzy = resolveFuzzy(doc, selector, hint, options);
		if (fuzzy) return fuzzy;
	}

	attempted.push("offset");
	const offset = resolveOffset(doc, selector, options);
	if (offset) return offset;

	return { ok: false, reason: "orphaned", attempted };
}
