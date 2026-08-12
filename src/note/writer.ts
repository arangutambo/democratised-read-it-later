/**
 * Writing import results into the vault.
 *
 * The invariant: on an existing note, only the managed region is ever touched. If the region
 * was hand-edited since we wrote it, nothing is overwritten — a `.conflict.md` sibling is
 * written instead and the note is left exactly as the user left it.
 */

import { normalizePath, TFile, TFolder, type App, type Vault } from "obsidian";

import { joinVaultPath, sanitiseFileName } from "../core/paths";
import { writeRegion, type WriteStatus } from "../core/managed-region";
import type { ImportResult } from "../core/types";
import { DEFAULT_HIGHLIGHTS_TEMPLATE, DEFAULT_NOTE_TEMPLATE, render } from "../template/engine";
import { buildVariables, type ColourResolver } from "../template/variables";

export const HIGHLIGHTS_REGION = "highlights";

export interface WriteOptions {
	sourcesFolder: string;
	confidenceThreshold: number;
	resolveColour?: ColourResolver;
	noteTemplate?: string;
	highlightsTemplate?: string;
}

export interface NoteWriteResult {
	path: string;
	status: WriteStatus;
	title: string;
	highlightCount: number;
	warnings: string[];
	needsReview: boolean;
	conflictPath?: string;
}

async function ensureFolder(vault: Vault, folder: string): Promise<void> {
	if (folder === "") return;
	const existing = vault.getAbstractFileByPath(folder);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`${folder} exists but is not a folder.`);

	// createFolder throws if a parent is missing, so build the chain top down.
	const segments = folder.split("/");
	let current = "";
	for (const segment of segments) {
		current = current === "" ? segment : `${current}/${segment}`;
		if (!(vault.getAbstractFileByPath(current) instanceof TFolder)) {
			try {
				await vault.createFolder(current);
			} catch {
				// Concurrent creation, or it appeared between the check and the call.
			}
		}
	}
}

/** The `readerSourceId` recorded in a note's frontmatter, if it has one. */
function sourceIdOf(app: App, path: string): string | undefined {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return undefined;
	const id = app.metadataCache.getFileCache(file)?.frontmatter?.readerSourceId;
	return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * A filename that belongs to this source alone.
 *
 * Two distinct books can produce the same filename — most obviously when neither is in the
 * Books library any more and both are titled "Untitled", which is the case for two real
 * assets here holding 1 and 58 highlights. Without this the second import would find the
 * first's note and quietly merge into it, silently fusing two books' highlights.
 *
 * The citekey is appended only when the name is genuinely taken by a *different* source, so
 * re-importing the same book keeps writing to the same file.
 */
function uniqueFileName(app: App, folder: string, result: ImportResult): string {
	const base = sanitiseFileName(result.source.title, result.source.citekey);
	const basePath = normalizePath(joinVaultPath(folder, `${base}.md`));
	const owner = sourceIdOf(app, basePath);

	if (owner === undefined || owner === result.source.id) return base;
	return sanitiseFileName(`${base} (${result.source.citekey})`, result.source.citekey);
}

export async function writeImport(
	app: App,
	result: ImportResult,
	options: WriteOptions,
): Promise<NoteWriteResult> {
	const { vault } = app;
	const folder = normalizePath(joinVaultPath(options.sourcesFolder));
	await ensureFolder(vault, folder);

	const fileName = uniqueFileName(app, folder, result);
	const path = normalizePath(joinVaultPath(folder, `${fileName}.md`));

	const needsReview = result.confidence < options.confidenceThreshold;
	const source = needsReview ? { ...result.source, state: "needs-review" as const } : result.source;

	const variables = buildVariables(source, result.highlights, options.resolveColour);
	const body = render(
		options.highlightsTemplate ?? DEFAULT_HIGHLIGHTS_TEMPLATE,
		variables,
		"highlights",
	).trim();

	const existing = vault.getAbstractFileByPath(path);

	if (!(existing instanceof TFile)) {
		const scaffold = render(options.noteTemplate ?? DEFAULT_NOTE_TEMPLATE, variables, "note");
		const { text } = writeRegion(scaffold, HIGHLIGHTS_REGION, body);
		await vault.create(path, text);
		return {
			path,
			status: "created",
			title: source.title,
			highlightCount: result.highlights.length,
			warnings: result.warnings,
			needsReview,
		};
	}

	const current = await vault.read(existing);
	const outcome = writeRegion(current, HIGHLIGHTS_REGION, body);

	if (outcome.status === "conflict") {
		// The user edited inside our region. Their version stays; ours lands beside it.
		const conflictPath = normalizePath(joinVaultPath(folder, `${fileName}.conflict.md`));
		const notice =
			`> [!warning] Reader could not update this note\n` +
			`> The highlights region in [[${fileName}]] was edited by hand since Reader last wrote it,\n` +
			`> so nothing was overwritten. Below is what Reader would have written. Merge what you\n` +
			`> want, then delete this file.\n\n`;

		const conflictFile = vault.getAbstractFileByPath(conflictPath);
		if (conflictFile instanceof TFile) await vault.modify(conflictFile, notice + body);
		else await vault.create(conflictPath, notice + body);

		return {
			path,
			status: "conflict",
			title: source.title,
			highlightCount: result.highlights.length,
			warnings: [...result.warnings, `Highlights region was hand-edited; wrote ${conflictPath} instead.`],
			needsReview,
			conflictPath,
		};
	}

	if (outcome.status !== "unchanged") await vault.modify(existing, outcome.text);

	return {
		path,
		status: outcome.status,
		title: source.title,
		highlightCount: result.highlights.length,
		warnings: result.warnings,
		needsReview,
	};
}
