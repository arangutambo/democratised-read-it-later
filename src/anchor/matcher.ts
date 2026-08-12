/**
 * Fuzzy quote location, using Google's diff-match-patch.
 *
 * This is the Hypothesis approach rather than the hand-rolled Levenshtein scan DESIGN.md
 * §5.1 specified: diff-match-patch has anchored annotations at scale for a decade, it is
 * Apache-2.0, and it costs 20 KB minified.
 *
 * The awkward part it does not solve for us is `Match_MaxBits = 32`. `match_main` is a bitap
 * search and cannot take a pattern longer than the word size, but the median real highlight
 * here is far longer than 32 characters — several run past 400. So a long pattern is located
 * by its head and then *verified* by edit distance over the candidate window, which is what
 * the two-stage search below does.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

import { diff_match_patch } from "diff-match-patch";

// The package declares a namespace beside the class under the same name, so the bare
// identifier resolves to the namespace in type position.
type Dmp = InstanceType<typeof diff_match_patch>;

/** Accepted edit distance as a fraction of quote length. DESIGN.md §5.1 asks for 10%. */
export const DEFAULT_DISTANCE_RATIO = 0.1;

export interface FuzzyMatch {
	start: number;
	end: number;
	/** Levenshtein distance between the quote and the matched window. */
	distance: number;
	/** 1 = identical, 0 = at the accepted limit. */
	score: number;
}

export interface FuzzyOptions {
	/** Maximum edit distance as a fraction of the quote's length. */
	distanceRatio?: number;
	/** How far from the hint diff-match-patch will look before giving up. */
	searchDistance?: number;
	/** Bitap acceptance threshold, 0 (exact) to 1 (anything). */
	threshold?: number;
}

function createEngine(options: FuzzyOptions): Dmp {
	const dmp = new diff_match_patch();
	dmp.Match_Threshold = options.threshold ?? 0.5;
	dmp.Match_Distance = options.searchDistance ?? 2_000;
	return dmp;
}

function levenshtein(dmp: Dmp, a: string, b: string): number {
	// diff_main is O(n·d); the cleanup pass is skipped because only the distance is wanted.
	return dmp.diff_levenshtein(dmp.diff_main(a, b));
}

/**
 * Locate `pattern` in `doc` near `hint`, tolerating edits.
 *
 * Returns null rather than a poor guess: a wrong anchor silently attaches a highlight to
 * unrelated text, which is worse than an orphan the user can see and fix.
 */
export function fuzzyFind(
	doc: string,
	pattern: string,
	hint: number | undefined,
	options: FuzzyOptions = {},
): FuzzyMatch | null {
	if (pattern === "" || doc === "") return null;

	/*
	 * Location bias has to be switched off when there is nothing to bias towards.
	 *
	 * diff-match-patch scores a candidate as error rate plus `proximity / Match_Distance`,
	 * so with the default 2000 anything more than ~2 KB from the seed is rejected outright.
	 * Apple Books highlights carry no stored offsets, so every search seeds at 0 — and
	 * measured against the real corpus that alone orphaned 56.5% of highlights under a 0.5%
	 * typo rate, which the 10% edit budget should have absorbed without noticing.
	 */
	const dmp = createEngine(
		hint === undefined
			? { ...options, searchDistance: options.searchDistance ?? Number.MAX_SAFE_INTEGER }
			: options,
	);
	const ratio = options.distanceRatio ?? DEFAULT_DISTANCE_RATIO;
	const budget = Math.max(1, Math.floor(pattern.length * ratio));
	const clampedHint = Math.min(Math.max(hint ?? 0, 0), doc.length);

	// Stage one: find where the quote starts. Bitap can only take Match_MaxBits characters,
	// so a long quote is located by its head.
	const head = pattern.slice(0, dmp.Match_MaxBits);
	const start = dmp.match_main(doc, head, clampedHint);
	if (start === -1) return null;

	// Stage two: verify the whole quote by edit distance. The end is unknown because edits
	// change length, so a few plausible window lengths are tried and the best kept.
	const lengths = new Set<number>([pattern.length]);
	for (const delta of [-budget, budget, -Math.floor(budget / 2), Math.floor(budget / 2)]) {
		const candidate = pattern.length + delta;
		if (candidate > 0) lengths.add(candidate);
	}

	let best: FuzzyMatch | null = null;
	for (const length of lengths) {
		const end = Math.min(doc.length, start + length);
		if (end <= start) continue;

		const distance = levenshtein(dmp, pattern, doc.slice(start, end));
		if (best === null || distance < best.distance) {
			best = { start, end, distance, score: 1 - distance / (budget + 1) };
		}
		if (distance === 0) break;
	}

	if (best === null || best.distance > budget) return null;
	return { ...best, score: Math.max(0, Math.min(1, best.score)) };
}

/** Edit distance between two strings, exposed for scoring elsewhere. */
export function editDistance(a: string, b: string): number {
	return levenshtein(new diff_match_patch(), a, b);
}
