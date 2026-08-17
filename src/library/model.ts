/**
 * What the library pane shows, and in what order.
 *
 * A row per document, built from its `.reader` file and its note. Everything here is derived —
 * nothing new is stored — because a library that keeps its own index goes stale the moment you
 * rename something, and this vault has 174 broken references that started exactly that way.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { ReaderDocument } from "../reader/document";

export type ReadingState = "unread" | "reading" | "finished";

export interface LibraryEntry {
	/** Vault path of the `.reader` file, which is what opens. */
	path: string;
	title: string;
	notePath: string;
	/** Where the source lives, for the subtitle. */
	sourcePath: string;
	page: number;
	pages?: number;
	clips: number;
	/** 0–1, or undefined when the page count is not known yet. */
	progress?: number;
	state: ReadingState;
	/** Epoch millis of the last change, for sorting. */
	modified: number;
}

export interface EntryInput {
	path: string;
	document: ReaderDocument;
	modified: number;
	/** Total pages, once the document has been opened at least once. */
	pages?: number;
}

/**
 * Reading state, inferred rather than recorded.
 *
 * A separate `readerState` field would be one more thing to keep in step with reality; the
 * position and the clip count already say everything a shelf needs to say.
 */
export function stateOf(page: number, pages: number | undefined, clips: number): ReadingState {
	if (pages !== undefined && pages > 0 && page >= pages) return "finished";
	// Page one with nothing clipped is a document you opened and did not start.
	return page > 1 || clips > 0 ? "reading" : "unread";
}

export function toEntry({ path, document, modified, pages }: EntryInput): LibraryEntry {
	const page = Math.max(1, document.view?.surface ?? 1);
	const clips = Object.keys(document.clips ?? {}).length;

	return {
		path,
		title: titleOf(path),
		notePath: document.notePath,
		sourcePath: document.source.path,
		page,
		pages,
		clips,
		progress: pages && pages > 0 ? Math.min(1, page / pages) : undefined,
		state: stateOf(page, pages, clips),
		modified,
	};
}

/** The document's name, without its folder or extension. */
export function titleOf(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.reader$/, "");
}

export type SortKey = "recent" | "title" | "progress";

export function sortEntries(entries: readonly LibraryEntry[], by: SortKey): LibraryEntry[] {
	const out = [...entries];

	switch (by) {
		case "title":
			return out.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
		case "progress":
			// Furthest through first, and anything unstarted last rather than tied at zero.
			return out.sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1));
		default:
			return out.sort((a, b) => b.modified - a.modified);
	}
}

/**
 * Filter by a typed query.
 *
 * Matches the title and the source path, so "binf" finds the deck and "workbook" finds the
 * file even when the note was renamed.
 */
export function filterEntries(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...entries];

	return entries.filter(
		(entry) =>
			entry.title.toLowerCase().includes(needle) ||
			entry.sourcePath.toLowerCase().includes(needle),
	);
}

/** A short line under the title: where it is up to, and how much has come out of it. */
export function subtitleOf(entry: LibraryEntry): string {
	const parts: string[] = [];

	if (entry.pages !== undefined) parts.push(`p${entry.page} of ${entry.pages}`);
	else if (entry.page > 1) parts.push(`p${entry.page}`);

	if (entry.clips > 0) parts.push(`${entry.clips} clip${entry.clips === 1 ? "" : "s"}`);

	return parts.join(" · ");
}
