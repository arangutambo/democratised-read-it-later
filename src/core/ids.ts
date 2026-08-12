/**
 * Identifier generation: ULIDs for highlights, citekeys for sources.
 *
 * PLAN.md §1: citekey stability is a hard requirement. Better BibTeX's history is the
 * warning — unstable keys silently break every draft that cites them and you find out at
 * submission. Both functions here are deterministic given their inputs, and callers store
 * the result rather than recomputing it.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_LENGTH = 16;
const TIME_LENGTH = 10;

export type RandomSource = (bytes: number) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => {
	const out = new Uint8Array(bytes);
	crypto.getRandomValues(out);
	return out;
};

function encodeTime(now: number): string {
	let out = "";
	let time = now;
	for (let i = TIME_LENGTH - 1; i >= 0; i--) {
		out = CROCKFORD[time % 32] + out;
		time = Math.floor(time / 32);
	}
	return out;
}

/**
 * ULID: 48-bit timestamp then 80 bits of randomness, Crockford base32.
 *
 * Lexicographically sortable by creation time, which keeps highlights in reading order
 * without a separate sort key.
 */
export function ulid(now: number = Date.now(), random: RandomSource = defaultRandom): string {
	const bytes = random(RANDOM_LENGTH);
	let out = "";
	for (let i = 0; i < RANDOM_LENGTH; i++) out += CROCKFORD[bytes[i] % 32];
	return encodeTime(now) + out;
}

/** Block id form used in markdown: `^hl-<lowercased ulid>`. */
export function blockId(highlightId: string): string {
	return `hl-${highlightId.toLowerCase()}`;
}

const STOPWORDS = new Set([
	"a", "an", "the", "on", "in", "of", "for", "and", "or", "to", "from", "with", "at", "by",
	"is", "are", "was", "were", "be", "how", "what", "why", "when",
]);

/** Strips diacritics and anything that is not a-z0-9, so citekeys stay BibTeX-safe. */
function fold(input: string): string {
	return input
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

/** Trailing credentials and generational suffixes are never surnames. */
const NOISE = /^(?:m\.?d\.?|ph\.?d\.?|facln|faclm|frcp|jr|sr|ii|iii|iv|dr|prof|mr|mrs|ms)\.?$/i;

/**
 * Surname from "Cowan, Nelson", "Nelson Cowan", "Michael Greger MD", or
 * "Michael Greger, M.D., FACLM".
 *
 * The last form is why this is not a one-liner: a comma does not reliably mean `Last, First`
 * — it just as often separates credentials, and reading it as `Last, First` yields the
 * surname "Michael Greger". Credential segments are dropped first, and only then does a
 * surviving comma imply `Last, First`.
 */
export function surnameOf(author: string): string {
	const trimmed = author.trim();
	if (trimmed === "") return "";

	const segments = trimmed
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "" && !NOISE.test(s.replace(/\s+/g, "")));

	if (segments.length === 0) return "";
	if (segments.length >= 2) return fold(segments[0]);

	const parts = segments[0]
		.split(/\s+/)
		.map((p) => p.replace(/[.,]/g, ""))
		.filter((p) => p !== "" && !NOISE.test(p));

	return parts.length === 0 ? "" : fold(parts[parts.length - 1]);
}

/** Meaningful title words in order, skipping articles and other stopwords. */
export function titleWordsOf(title: string, count = 1): string[] {
	const words = title.split(/\s+/).map(fold).filter((w) => w !== "");
	const meaningful = words.filter((w) => !STOPWORDS.has(w));
	const chosen = (meaningful.length > 0 ? meaningful : words).slice(0, count);
	return chosen;
}

/** First meaningful title word, skipping articles and other stopwords. */
export function titleWordOf(title: string): string {
	return titleWordsOf(title, 1)[0] ?? "";
}

export interface CitekeyParts {
	author?: string;
	year?: number | string;
	title?: string;
}

/**
 * Deterministic base citekey: surname + year + title word(s).
 *
 * When no year is available the key falls back to **two** title words instead of one. That
 * is not cosmetic. Apple Books records a publication year for 5 of 384 books and for none of
 * the annotated ones, so a single-word key collapses distinct books together: "The How Not
 * to Die Cookbook" and "How Not to Diet" both reduce to `gregernot`, and the loser gets an
 * arbitrary `a`/`b` suffix. Two words give `gregernotdie` and `gregernotdiet`, which stay
 * meaningful and stable. Citekeys are written once and never recomputed, so this had to be
 * settled before the first import rather than improved later.
 */
export function baseCitekey({ author, year, title }: CitekeyParts): string {
	const surname = author ? surnameOf(author) : "";
	const yearPart = year !== undefined && year !== null && `${year}` !== "" ? `${year}` : "";
	const words = title ? titleWordsOf(title, yearPart === "" ? 2 : 1).join("") : "";
	const key = `${surname}${yearPart}${words}`;
	return key === "" ? "untitled" : key;
}

/**
 * Collision-safe citekey. Appends a, b, c… only when the base is already taken by a
 * *different* source, so re-importing the same source keeps its original key.
 */
export function makeCitekey(parts: CitekeyParts, taken: ReadonlySet<string>): string {
	const base = baseCitekey(parts);
	if (!taken.has(base)) return base;

	for (let i = 0; i < 26; i++) {
		const candidate = `${base}${String.fromCharCode(97 + i)}`;
		if (!taken.has(candidate)) return candidate;
	}
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}
