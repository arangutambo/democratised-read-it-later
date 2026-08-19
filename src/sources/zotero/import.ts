/**
 * Zotero annotation migration, end to end.
 *
 * The point of this, in Antoine's words: papers are annotated in Zotero but the annotating
 * should happen in Obsidian. So annotations move **out** once — text, comment, colour and
 * page geometry — into notes that carry Better BibTeX's own citekey. Zotero is never written
 * to, and keeps doing what it is good at: storing PDFs and generating `library.bib`.
 *
 * Using BBT's citekey rather than minting one is the whole reason this is a migration and
 * not a fork: a note here and a `\cite{}` in a manuscript then name the same thing.
 */

import type { App } from "obsidian";

import type { ImportResult } from "../../core/types";
import { writeImport, type NoteWriteResult, type WriteOptions } from "../../note/writer";
import { locateZotero, readZotero, ZoteroUnavailableError } from "./db";
import { buildImports } from "./map";

export { ZoteroUnavailableError };

export interface ZoteroImportOptions extends WriteOptions {
	/** Zotero's data directory. Blank uses ~/Zotero. */
	dataDir?: string;
	onProgress?: (current: number, total: number, label: string) => void;
}

export interface ZoteroImportSummary {
	notes: NoteWriteResult[];
	warnings: string[];
	totalHighlights: number;
	created: number;
	updated: number;
	unchanged: number;
	conflicts: number;
	needsReview: number;
	withoutCitekey: number;
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

export async function importFromZotero(
	app: App,
	options: ZoteroImportOptions,
): Promise<ZoteroImportSummary> {
	const paths = await locateZotero(options.dataDir?.trim() ? options.dataDir.trim() : undefined);
	const data = await readZotero(paths);

	const results: ImportResult[] = buildImports({
		items: data.items,
		annotations: data.annotations,
		fields: data.fields,
		creators: data.creators,
		citekeys: data.citekeys,
		dataDir: paths.dataDir,
	});

	const summary: ZoteroImportSummary = {
		notes: [],
		warnings: [...data.warnings],
		totalHighlights: 0,
		created: 0,
		updated: 0,
		unchanged: 0,
		conflicts: 0,
		needsReview: 0,
		withoutCitekey: 0,
	};

	for (const [index, result] of results.entries()) {
		options.onProgress?.(index + 1, results.length, result.source.title);

		const written = await writeImport(app, result, options);
		summary.notes.push(written);
		summary.totalHighlights += written.highlightCount;

		if (written.status === "created") summary.created++;
		else if (written.status === "updated") summary.updated++;
		else if (written.status === "unchanged") summary.unchanged++;
		else if (written.status === "conflict") summary.conflicts++;
		if (written.needsReview) summary.needsReview++;
		if (result.warnings.some((w) => w.includes("Better BibTeX"))) summary.withoutCitekey++;

		await yieldToUi();
	}

	return summary;
}
