/**
 * Dry run of the Apple Books pipeline against the real databases.
 *
 * Reads, maps and renders exactly as the plugin does, then prints a summary and one sample
 * note — but writes nothing to the vault. This is the pre-release gate described in PLAN.md
 * §5: the committed fixtures are synthetic, so this is the only thing that exercises the
 * pipeline against real data, and it is run by hand rather than in CI.
 *
 *   npm run books:dry-run
 */

import { locateDatabases, readBooks, withCopiedDatabases, assertSqliteAvailable } from "../src/sources/books/db";
import { buildImports } from "../src/sources/books/map";
import { writeRegion } from "../src/core/managed-region";
import { DEFAULT_HIGHLIGHTS_TEMPLATE, DEFAULT_NOTE_TEMPLATE, render } from "../src/template/engine";
import { buildVariables } from "../src/template/variables";

const SAMPLE_TITLE = process.argv[2];

/**
 * Point at copies rather than the live container:
 *   READER_BOOKS_ANNOTATIONS=/path/to/AEAnnotation.sqlite READER_BOOKS_LIBRARY=/path/BKLibrary.sqlite
 * Reading the live container needs Full Disk Access; a copy made by a process that has it
 * works everywhere.
 */
const override = {
	annotations: process.env.READER_BOOKS_ANNOTATIONS,
	library: process.env.READER_BOOKS_LIBRARY,
};

async function main(): Promise<void> {
	await assertSqliteAvailable();

	const paths = await locateDatabases({ override });
	console.log("annotations:", paths.annotations);
	console.log("library:    ", paths.library, "\n");

	const started = Date.now();
	const { assets, annotations, warnings } = await withCopiedDatabases(paths, readBooks);
	const readMs = Date.now() - started;

	console.log(`read ${annotations.length} annotations and ${assets.length} library assets in ${readMs}ms`);
	for (const warning of warnings) console.log("  schema warning:", warning);

	const results = buildImports(assets, annotations);
	const totalHighlights = results.reduce((n, r) => n + r.highlights.length, 0);

	console.log(`\nbuilt ${results.length} notes covering ${totalHighlights} highlights\n`);

	console.log("citekey                        highlights  conf  title");
	console.log("-".repeat(96));
	for (const r of results) {
		console.log(
			`${r.source.citekey.padEnd(30)} ${String(r.highlights.length).padStart(10)}  ${r.confidence
				.toFixed(2)
				.padStart(4)}  ${r.source.title.slice(0, 44)}`,
		);
		for (const w of r.warnings) console.log(`${" ".repeat(32)}! ${w}`);
	}

	// Anchoring quality: what share of highlights got real disambiguating context?
	const all = results.flatMap((r) => r.highlights);
	const withContext = all.filter((h) => h.anchors.quote.prefix !== "" || h.anchors.quote.suffix !== "");
	const withCfi = all.filter((h) => h.anchors.cfi);
	const withNote = all.filter((h) => h.note);

	console.log("\nanchoring:");
	console.log(`  prefix/suffix context: ${withContext.length}/${all.length} (${pct(withContext.length, all.length)})`);
	console.log(`  EPUB CFI:              ${withCfi.length}/${all.length} (${pct(withCfi.length, all.length)})`);
	console.log(`  carrying a note:       ${withNote.length}/${all.length} (${pct(withNote.length, all.length)})`);

	const citekeys = results.map((r) => r.source.citekey);
	console.log(`  citekey collisions:    ${citekeys.length - new Set(citekeys).size}`);

	const sample = SAMPLE_TITLE
		? results.find((r) => r.source.title.toLowerCase().includes(SAMPLE_TITLE.toLowerCase()))
		: results.find((r) => r.highlights.length > 2 && r.highlights.length < 12);

	if (!sample) return;

	const variables = buildVariables(sample.source, sample.highlights.slice(0, 3));
	const body = render(DEFAULT_HIGHLIGHTS_TEMPLATE, variables, "highlights").trim();
	const note = writeRegion(render(DEFAULT_NOTE_TEMPLATE, variables, "note"), "highlights", body).text;

	console.log(`\n${"=".repeat(96)}\nsample note — ${sample.source.title} (first 3 highlights)\n${"=".repeat(96)}`);
	console.log(note);
}

function pct(n: number, total: number): string {
	return total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;
}

main().catch((error) => {
	console.error("dry run failed:", error);
	process.exit(1);
});
