/**
 * Dry run of the Zotero migration against the real library.
 *
 *   npm run zotero:dry-run
 *
 * Reads, maps and renders exactly as the plugin does, then prints what it would write —
 * without touching the vault. `~/Zotero/` is not TCC-protected, so unlike the Books importer
 * this needs no Full Disk Access.
 */

import { locateZotero, readZotero } from "../src/sources/zotero/db";
import { buildImports } from "../src/sources/zotero/map";
import { writeRegion } from "../src/core/managed-region";
import { DEFAULT_HIGHLIGHTS_TEMPLATE, DEFAULT_NOTE_TEMPLATE, render } from "../src/template/engine";
import { buildVariables } from "../src/template/variables";

async function main(): Promise<void> {
	const paths = await locateZotero(process.env.READER_ZOTERO_DIR);
	console.log("library:      ", paths.library);
	console.log("better bibtex:", paths.betterBibtex ?? "(not installed)", "\n");

	const started = Date.now();
	const data = await readZotero(paths);
	console.log(
		`read ${data.annotations.length} annotations, ${data.items.length} items, ` +
			`${data.citekeys.size} Better BibTeX citekeys in ${Date.now() - started}ms`,
	);
	for (const warning of data.warnings) console.log("  warning:", warning);

	const results = buildImports({
		items: data.items,
		annotations: data.annotations,
		fields: data.fields,
		creators: data.creators,
		citekeys: data.citekeys,
		dataDir: paths.dataDir,
	});

	const total = results.reduce((n, r) => n + r.highlights.length, 0);
	console.log(`\nwould write ${results.length} note(s) covering ${total} highlight(s)\n`);

	console.log("citekey                              hl  conf  title");
	console.log("-".repeat(96));
	for (const r of results) {
		console.log(
			`${r.source.citekey.slice(0, 36).padEnd(36)} ${String(r.highlights.length).padStart(3)}  ` +
				`${r.confidence.toFixed(2)}  ${r.source.title.slice(0, 46)}`,
		);
		for (const w of r.warnings) console.log(`${" ".repeat(38)}! ${w}`);
	}

	const all = results.flatMap((r) => r.highlights);
	console.log("\nanchors:");
	console.log(`  with page geometry (quad): ${all.filter((h) => h.anchors.quad).length}/${all.length}`);
	console.log(`  carrying a comment:        ${all.filter((h) => h.note).length}/${all.length}`);
	console.log(`  attachment resolved:       ${results.filter((r) => r.source.libraryPath).length}/${results.length}`);

	const sample = results.find((r) => r.highlights.length > 0);
	if (!sample) return;

	const variables = buildVariables(sample.source, sample.highlights.slice(0, 3));
	const body = render(DEFAULT_HIGHLIGHTS_TEMPLATE, variables, "highlights").trim();
	const note = writeRegion(render(DEFAULT_NOTE_TEMPLATE, variables, "note"), "highlights", body).text;

	console.log(`\n${"=".repeat(96)}\nsample note — ${sample.source.title}\n${"=".repeat(96)}`);
	console.log(note);
}

main().catch((error) => {
	console.error("zotero dry run failed:", error);
	process.exit(1);
});
