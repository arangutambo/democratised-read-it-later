/**
 * Apple Books import, end to end. Desktop and macOS only — `main.ts` imports this module
 * lazily so mobile never evaluates the node builtins it pulls in through `db.ts`.
 */

import { TFile, type App } from "obsidian";

import { joinVaultPath } from "../../core/paths";
import type { ImportResult } from "../../core/types";
import { writeImport, type NoteWriteResult, type WriteOptions } from "../../note/writer";
import { locateDatabases, readBooks, withCopiedDatabases, assertSqliteAvailable } from "./db";
import { buildImports } from "./map";

export interface ImportProgress {
	stage: "reading" | "writing";
	current: number;
	total: number;
	label?: string;
}

export interface BooksImportOptions extends WriteOptions {
	onProgress?: (progress: ImportProgress) => void;
}

export interface BooksImportSummary {
	notes: NoteWriteResult[];
	warnings: string[];
	totalHighlights: number;
	created: number;
	updated: number;
	unchanged: number;
	conflicts: number;
	needsReview: number;
}

/**
 * Citekeys already assigned by a previous import, read from note frontmatter.
 *
 * This is what makes re-import idempotent: a book keeps the citekey it was first given even
 * if Apple's metadata for it changes, so nothing that cites it breaks.
 */
function existingCitekeys(app: App, sourcesFolder: string): Map<string, string> {
	const found = new Map<string, string>();
	const prefix = joinVaultPath(sourcesFolder);

	for (const file of app.vault.getMarkdownFiles()) {
		if (prefix !== "" && !file.path.startsWith(`${prefix}/`)) continue;

		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		const sourceId = frontmatter?.readerSourceId;
		const citekey = frontmatter?.citekey;

		if (typeof sourceId === "string" && sourceId !== "" && typeof citekey === "string" && citekey !== "") {
			found.set(sourceId, citekey);
		}
	}

	return found;
}

/** Lets the UI paint between notes; writing 23 files without this blocks the main thread. */
const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function importFromAppleBooks(
	app: App,
	options: BooksImportOptions,
): Promise<BooksImportSummary> {
	await assertSqliteAvailable();

	options.onProgress?.({ stage: "reading", current: 0, total: 1 });

	const paths = await locateDatabases();
	const { assets, annotations, warnings } = await withCopiedDatabases(paths, readBooks);

	const results: ImportResult[] = buildImports(assets, annotations, {
		existingCitekeys: existingCitekeys(app, options.sourcesFolder),
	});

	const summary: BooksImportSummary = {
		notes: [],
		warnings: [...warnings],
		totalHighlights: 0,
		created: 0,
		updated: 0,
		unchanged: 0,
		conflicts: 0,
		needsReview: 0,
	};

	for (const [index, result] of results.entries()) {
		options.onProgress?.({
			stage: "writing",
			current: index + 1,
			total: results.length,
			label: result.source.title,
		});

		const written = await writeImport(app, result, options);
		summary.notes.push(written);
		summary.totalHighlights += written.highlightCount;

		if (written.status === "created") summary.created++;
		else if (written.status === "updated") summary.updated++;
		else if (written.status === "unchanged") summary.unchanged++;
		else if (written.status === "conflict") summary.conflicts++;
		if (written.needsReview) summary.needsReview++;

		await yieldToUi();
	}

	return summary;
}

/** Frontmatter toggle behind the `Toggle reader mode` command. */
export async function toggleReaderFrontmatter(app: App, file: TFile): Promise<boolean> {
	let next = false;
	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		if (typeof frontmatter.readerState === "string") {
			// An imported note is already a reader note; leave its metadata alone.
			next = true;
			return;
		}
		next = frontmatter.reader !== true;
		if (next) frontmatter.reader = true;
		else delete frontmatter.reader;
	});
	return next;
}
