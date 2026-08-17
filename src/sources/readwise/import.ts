/**
 * Planning the exit from Readwise.
 *
 * Decides what an import would write, before anything is written. The vault work is then a
 * loop over a list rather than a tangle of conditionals holding a file handle: it can be
 * counted, shown to you, and tested against the real 5,542-row export without a vault.
 *
 * Two things make this re-runnable, which matters because the first attempt on a library this
 * size will be interrupted. The Readwise id is in every filename and in `readerSourceId`, so a
 * second run recognises what it already wrote; and a document whose note exists is skipped
 * whole rather than merged, because a note you have since written in is yours.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import { importable, matchFilename, type ReadwiseDocument } from "./export";
import { documentPathFor, extensionOf, noteNameFor, readableExtension } from "./note";

export interface PlannedImport {
	document: ReadwiseDocument;
	notePath: string;
	/** The entry in the uploaded-files zip holding the document, when it was exported. */
	zipEntry?: string;
	/** Where that file is copied to in the vault. */
	documentPath?: string;
	/** The `.reader` to create beside it, when Reader can open the file. */
	readerPath?: string;
}

export interface ImportPlan {
	/** What this run would write. */
	writes: PlannedImport[];
	/** Documents whose note already exists — a second run's evidence that the first worked. */
	alreadyImported: number;
	/** In the export but left out by the filter, overwhelmingly the feed. */
	filteredOut: number;
	/** Kept as notes with a link, because Reader cannot open the file yet. Mostly HTML. */
	linkOnly: number;
}

export interface PlanOptions {
	/** Where notes go. */
	sourcesFolder: string;
	/** Where the exported documents themselves are copied. */
	documentsFolder: string;
	/** Names in the uploaded-files zip. Empty plans notes with links and nothing else. */
	zipEntries?: readonly string[];
	/** Note paths that already exist in the vault. */
	existingNotes?: ReadonlySet<string>;
	/** The feed is 3,443 of 5,542 rows and is excluded unless asked for. */
	includeFeed?: boolean;
}

function join(folder: string, name: string): string {
	return folder === "" ? name : `${folder}/${name}`;
}

/**
 * What an import would write.
 *
 * Nothing here touches a vault, so this can be run against the real export to answer "how many
 * files is this, actually" before committing to it.
 */
export function planImport(
	documents: readonly ReadwiseDocument[],
	options: PlanOptions,
): ImportPlan {
	const kept = importable(documents, { includeFeed: options.includeFeed });
	const entries = options.zipEntries ?? [];
	const existing = options.existingNotes ?? new Set<string>();

	const writes: PlannedImport[] = [];
	let alreadyImported = 0;
	let linkOnly = 0;

	for (const document of kept) {
		const notePath = join(options.sourcesFolder, noteNameFor(document));

		/*
		 * Skipped whole, never merged.
		 *
		 * By the second run a note may have clips and your prose under them. The export cannot
		 * know that, and the only safe reading of "already imported" is "leave it alone".
		 */
		if (existing.has(notePath)) {
			alreadyImported++;
			continue;
		}

		const zipEntry = matchFilename(entries, document.id);
		const planned: PlannedImport = { document, notePath, zipEntry };

		if (zipEntry !== undefined) {
			const extension = extensionOf(zipEntry);
			planned.documentPath = documentPathFor(document, options.documentsFolder, extension);

			// A `.reader` only where there is something it can render; see readableExtension.
			if (readableExtension(extension) !== undefined) {
				planned.readerPath = `${planned.documentPath.slice(0, -extension.length - 1)}.reader`;
			} else {
				linkOnly++;
			}
		} else {
			linkOnly++;
		}

		writes.push(planned);
	}

	return {
		writes,
		alreadyImported,
		filteredOut: documents.length - kept.length,
		linkOnly,
	};
}

/** A one-line account of a plan, for the confirmation step. */
export function describePlan(plan: ImportPlan): string {
	const readable = plan.writes.length - plan.linkOnly;
	const parts = [`${plan.writes.length} note${plan.writes.length === 1 ? "" : "s"}`];

	if (readable > 0) parts.push(`${readable} openable in Reader`);
	if (plan.linkOnly > 0) parts.push(`${plan.linkOnly} as a link`);
	if (plan.alreadyImported > 0) parts.push(`${plan.alreadyImported} already imported`);
	if (plan.filteredOut > 0) parts.push(`${plan.filteredOut} skipped`);

	return parts.join(", ");
}
