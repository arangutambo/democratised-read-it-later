/**
 * Running the Readwise import against a vault.
 *
 * `import.ts` decides what to write; this writes it. The split is what lets the decision be
 * shown to you and confirmed before ~2,100 files appear, and what lets the whole plan be
 * tested against a real 5,542-row export with no vault in sight.
 *
 * Nothing here needs a token, a network, or a live subscription: the inputs are the two files
 * Readwise hands you on the way out. Once this has run you can cancel the account.
 */

import type { App, Vault } from "obsidian";

import { ZipArchive } from "../../epub/zip";
import { createDocument, serialise, type SourceKind } from "../../reader/document";
import { parseExport } from "./export";
import { describePlan, planImport, type PlannedImport } from "./import";
import { buildNote, readableExtension, extensionOf } from "./note";

export interface RunOptions {
	/** The export CSV, as text. */
	csv: string;
	/** The uploaded-files zip, when you downloaded it. Without it, notes carry links. */
	zip?: Uint8Array;
	sourcesFolder: string;
	documentsFolder: string;
	includeFeed?: boolean;
	onProgress?: (progress: { current: number; total: number; label: string }) => void;
	/** Stops mid-run, leaving what is already written in place. */
	shouldStop?: () => boolean;
}

export interface RunSummary {
	notes: number;
	documents: number;
	readers: number;
	alreadyImported: number;
	filteredOut: number;
	/** Documents that could not be written, with why. Never thrown — one bad row of 5,542. */
	failures: { title: string; reason: string }[];
	stopped: boolean;
	description: string;
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (folder === "" || app.vault.getAbstractFileByPath(folder)) return;

	// Nested folders need each level; createFolder does not make parents.
	const parts = folder.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const partial = parts.slice(0, i).join("/");
		if (app.vault.getAbstractFileByPath(partial)) continue;
		await app.vault.createFolder(partial).catch(() => {
			// Appearing between the check and the call is the desired outcome either way.
		});
	}
}

/** Every markdown path in the vault, to recognise what a previous run already wrote. */
function existingNotes(vault: Vault): Set<string> {
	return new Set(vault.getMarkdownFiles().map((file) => file.path));
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Import a Readwise export into the vault.
 *
 * Failures are collected rather than thrown. At this scale a single unreadable zip entry or a
 * name the filesystem rejects is expected, and abandoning 2,000 good documents over one bad
 * one would make the import unusable exactly when it matters.
 */
export async function runImport(app: App, options: RunOptions): Promise<RunSummary> {
	const archive = options.zip ? ZipArchive.open(options.zip) : undefined;

	const plan = planImport(parseExport(options.csv), {
		sourcesFolder: options.sourcesFolder,
		documentsFolder: options.documentsFolder,
		zipEntries: archive?.names ?? [],
		existingNotes: existingNotes(app.vault),
		includeFeed: options.includeFeed,
	});

	const summary: RunSummary = {
		notes: 0,
		documents: 0,
		readers: 0,
		alreadyImported: plan.alreadyImported,
		filteredOut: plan.filteredOut,
		failures: [],
		stopped: false,
		description: describePlan(plan),
	};

	if (plan.writes.length === 0) return summary;

	await ensureFolder(app, options.sourcesFolder);
	if (plan.writes.some((write) => write.documentPath)) {
		await ensureFolder(app, options.documentsFolder);
	}

	let index = 0;
	for (const write of plan.writes) {
		if (options.shouldStop?.()) {
			summary.stopped = true;
			break;
		}

		index++;
		options.onProgress?.({ current: index, total: plan.writes.length, label: write.document.title });

		try {
			await writeOne(app, write, archive, summary);
		} catch (error) {
			summary.failures.push({ title: write.document.title || write.document.id, reason: reason(error) });
		}
	}

	return summary;
}

async function writeOne(
	app: App,
	write: PlannedImport,
	archive: ZipArchive | undefined,
	summary: RunSummary,
): Promise<void> {
	let documentPath = write.documentPath;
	let readerPath = write.readerPath;

	/*
	 * The document first, because the note points at it.
	 *
	 * A zip entry that will not inflate downgrades this document to a note with a link rather
	 * than failing it: the metadata is still worth having, and the file is still in the export
	 * if you want it later.
	 */
	if (archive && write.zipEntry && documentPath) {
		try {
			if (!app.vault.getAbstractFileByPath(documentPath)) {
				const bytes = await archive.read(write.zipEntry);
				await app.vault.createBinary(documentPath, bytes.slice().buffer as ArrayBuffer);
			}
			summary.documents++;
		} catch (error) {
			summary.failures.push({
				title: write.document.title || write.document.id,
				reason: `file not extracted (${reason(error)})`,
			});
			documentPath = undefined;
			readerPath = undefined;
		}
	}

	if (documentPath && readerPath && !app.vault.getAbstractFileByPath(readerPath)) {
		const kind = readableExtension(extensionOf(documentPath)) as SourceKind | undefined;
		if (kind) {
			await app.vault.create(readerPath, serialise(createDocument(documentPath, kind, write.notePath)));
			summary.readers++;
		}
	}

	await app.vault.create(write.notePath, buildNote(write.document, { documentPath, readerPath }));
	summary.notes++;
}
