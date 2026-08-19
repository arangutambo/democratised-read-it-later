/**
 * Re-anchoring benchmark against the real Apple Books corpus.
 *
 * PLAN.md §5: the committed fixtures are synthetic, so this is the only thing that measures
 * the resolution ladder against real highlights — 1,177 of them, with the prefix/suffix
 * context Apple actually recorded. It is a **local gate before a release**, never CI: the
 * corpus is private and copyrighted and cannot be published.
 *
 *   npm run anchor:bench
 *
 * Method. For each book, the representative texts of its highlights are concatenated into a
 * pseudo-document — which realistically reproduces the hard case, since a book's own prose
 * repeats phrases. Each document is then perturbed the way real documents change, and every
 * highlight is re-anchored against the perturbed version.
 *
 * The number that matters is not "resolved". It is **mis-anchored**: a highlight the ladder
 * placed confidently in the wrong place. An orphan is visible and reviewable; a wrong anchor
 * is silent, and silently attaching a highlight to text the user never highlighted is the
 * worst thing this system can do.
 */

import { editDistance } from "../src/anchor/matcher";
import { resolveAll } from "../src/anchor/scheduler";
import type { Highlight } from "../src/core/types";
import { locateDatabases, readBooks, withCopiedDatabases, assertSqliteAvailable } from "../src/sources/books/db";
import { buildImports } from "../src/sources/books/map";
import { say, warn } from "./report";

const override = {
	annotations: process.env.READER_BOOKS_ANNOTATIONS,
	library: process.env.READER_BOOKS_LIBRARY,
};

/** Correct means "found substantially the right text", tolerant of the perturbation itself. */
const CORRECTNESS_TOLERANCE = 0.25;

interface Scenario {
	name: string;
	description: string;
	perturb: (doc: string) => string;
}

/** Deterministic PRNG so a regression is reproducible rather than a coin toss. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const ASCII_FOLD: Record<string, string> = {
	"’": "'", "‘": "'", "“": '"', "”": '"', "—": "-", "–": "-", "…": "...",
};

const SCENARIOS: Scenario[] = [
	{
		name: "pristine",
		description: "unchanged document",
		perturb: (doc) => doc,
	},
	{
		name: "reflowed",
		description: "line breaks and spacing changed, as when text is re-extracted",
		perturb: (doc) => doc.replace(/ /g, (_, i: number) => (i % 7 === 0 ? "\n  " : " ")),
	},
	{
		name: "ascii-punctuation",
		description: "typographic quotes and dashes flattened, as a PDF extractor would",
		perturb: (doc) => doc.replace(/[’‘“”—–…]/g, (c) => ASCII_FOLD[c] ?? c),
	},
	{
		name: "typos",
		description: "0.5% of characters altered, as in a lightly edited page",
		perturb: (doc) => {
			const random = makeRandom(42);
			return [...doc].map((c) => (random() < 0.005 && /[a-z]/.test(c) ? "x" : c)).join("");
		},
	},
	{
		name: "insertions",
		description: "new sentences inserted throughout, as when an article is expanded",
		perturb: (doc) => {
			const random = makeRandom(7);
			return doc
				.split(". ")
				.map((s) => (random() < 0.2 ? `${s}. An editor added this sentence later` : s))
				.join(". ");
		},
	},
	{
		name: "truncated",
		description: "a fifth of the document deleted, as when a page is restructured",
		perturb: (doc) => {
			const cut = Math.floor(doc.length * 0.4);
			return doc.slice(0, cut) + doc.slice(cut + Math.floor(doc.length * 0.2));
		},
	},
];

interface Outcome {
	total: number;
	correct: number;
	misanchored: number;
	orphaned: number;
	byStrategy: Record<string, number>;
	ambiguous: number;
	ms: number;
}

function isCorrect(found: string, expected: string): boolean {
	if (found === expected) return true;
	const distance = editDistance(found, expected);
	return distance / Math.max(expected.length, 1) <= CORRECTNESS_TOLERANCE;
}

async function runScenario(
	scenario: Scenario,
	documents: { doc: string; highlights: Highlight[] }[],
): Promise<Outcome> {
	const outcome: Outcome = {
		total: 0,
		correct: 0,
		misanchored: 0,
		orphaned: 0,
		byStrategy: {},
		ambiguous: 0,
		ms: 0,
	};

	const started = Date.now();

	for (const { doc, highlights } of documents) {
		const perturbed = scenario.perturb(doc);
		const { resolutions } = await resolveAll(perturbed, highlights, { chunkSize: 500 });

		for (const highlight of highlights) {
			outcome.total++;
			const resolution = resolutions.get(highlight.id);

			if (!resolution || !resolution.ok) {
				outcome.orphaned++;
				continue;
			}

			outcome.byStrategy[resolution.strategy] = (outcome.byStrategy[resolution.strategy] ?? 0) + 1;
			if (resolution.ambiguous) outcome.ambiguous++;

			if (isCorrect(perturbed.slice(resolution.start, resolution.end), highlight.text)) outcome.correct++;
			else outcome.misanchored++;
		}
	}

	outcome.ms = Date.now() - started;
	return outcome;
}

function pct(n: number, total: number): string {
	return total === 0 ? "  n/a" : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

async function main(): Promise<void> {
	await assertSqliteAvailable();

	const paths = await locateDatabases({ override });
	const { assets, annotations } = await withCopiedDatabases(paths, readBooks);
	const imports = buildImports(assets, annotations);

	// One pseudo-document per book, built from the context Apple recorded around each
	// highlight. Concatenating a book's own prose reproduces the repeated-phrase problem.
	const documents = imports
		.map((result) => ({
			doc: result.highlights.map((h) => `${h.anchors.quote.prefix}${h.text}${h.anchors.quote.suffix}`).join("\n\n"),
			highlights: result.highlights,
		}))
		.filter((d) => d.doc.length > 0);

	const totalHighlights = documents.reduce((n, d) => n + d.highlights.length, 0);
	say(`corpus: ${documents.length} books, ${totalHighlights} highlights\n`);

	say(
		"scenario           correct  misanchor  orphan   exact  normal   fuzzy  offset   ambig     ms",
	);
	say("-".repeat(100));

	let worstMisanchor = 0;

	for (const scenario of SCENARIOS) {
		const o = await runScenario(scenario, documents);
		worstMisanchor = Math.max(worstMisanchor, o.misanchored / Math.max(o.total, 1));

		say(
			`${scenario.name.padEnd(18)}${pct(o.correct, o.total)}     ${pct(o.misanchored, o.total)}  ${pct(
				o.orphaned,
				o.total,
			)}  ` +
				`${String(o.byStrategy.exact ?? 0).padStart(6)}  ${String(o.byStrategy.normalised ?? 0).padStart(
					6,
				)}  ${String(o.byStrategy.fuzzy ?? 0).padStart(6)}  ${String(o.byStrategy.offset ?? 0).padStart(6)}  ` +
				`${String(o.ambiguous).padStart(6)}  ${String(o.ms).padStart(5)}`,
		);
	}

	say("\n" + "-".repeat(100));
	for (const scenario of SCENARIOS) say(`  ${scenario.name.padEnd(18)} ${scenario.description}`);

	say(
		`\nmis-anchoring is the failure that matters: worst case ${(worstMisanchor * 100).toFixed(1)}%.\n` +
			`an orphan is visible and reviewable; a wrong anchor is silent.`,
	);
}

main().catch((error) => {
	warn("benchmark failed:", error);
	process.exit(1);
});
