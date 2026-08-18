/**
 * Reading the shelf without the shelf being open.
 *
 * The library pane holds its own entries, but the commands — search, next unread, continue —
 * have to work from a keystroke with no pane in sight. Both read through here so there is one
 * definition of what a document is and what state it is in.
 */

import type { App, TFile } from "obsidian";

import { parseDocument } from "../reader/document";
import { toEntry, type LibraryEntry } from "./model";

export interface ScanOptions {
	/** Page counts learned by opening documents. Absent ones simply have no progress yet. */
	pageCounts?: Map<string, number>;
	/** Stop after this many, for a caller that only needs the first few. */
	limit?: number;
}

/** One `.reader`, or undefined when it will not parse. */
export async function readEntry(
	app: App,
	file: TFile,
	pageCounts?: Map<string, number>,
): Promise<LibraryEntry | undefined> {
	try {
		const { document } = parseDocument(await app.vault.read(file));
		return toEntry({
			path: file.path,
			document,
			modified: file.stat.mtime,
			pages: pageCounts?.get(file.path),
		});
	} catch {
		// One unparseable file must not empty the shelf.
		return undefined;
	}
}

/** Every document Reader knows about. */
export async function scanLibrary(app: App, options: ScanOptions = {}): Promise<LibraryEntry[]> {
	const files = app.vault.getFiles().filter((file) => file.extension === "reader");
	const entries: LibraryEntry[] = [];

	for (const file of files) {
		const entry = await readEntry(app, file, options.pageCounts);
		if (entry) entries.push(entry);
		if (options.limit !== undefined && entries.length >= options.limit) break;
	}

	return entries;
}
