/**
 * What each document points at, remembered before it is needed.
 *
 * Deleting a `.reader` and then asking it which note and file it belonged to is too late: the
 * answer was inside the file that just went. Obsidian has no "about to delete" event, so the
 * mapping has to already be in memory when the deletion arrives.
 *
 * It is only worth carrying when it is going to be used. With "deleting a document takes its
 * file and note with it" switched off — the default — nothing here is ever populated, so the
 * cost of the feature falls entirely on the people who asked for it.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { ReaderDocument } from "../reader/document";

export interface DocumentLink {
	notePath: string;
	/** Where the document itself lives. Absolute for a file outside the vault. */
	sourcePath: string;
}

export class DocumentLinks {
	private readonly links = new Map<string, DocumentLink>();

	get size(): number {
		return this.links.size;
	}

	/** Record what a `.reader` points at. */
	remember(readerPath: string, document: ReaderDocument): void {
		this.links.set(readerPath, {
			notePath: document.notePath,
			sourcePath: document.source.path,
		});
	}

	get(readerPath: string): DocumentLink | undefined {
		return this.links.get(readerPath);
	}

	forget(readerPath: string): DocumentLink | undefined {
		const link = this.links.get(readerPath);
		this.links.delete(readerPath);
		return link;
	}

	/** Follow a `.reader` that was moved or renamed, so its links survive the move. */
	rename(oldPath: string, newPath: string): void {
		const link = this.links.get(oldPath);
		if (!link) return;

		this.links.delete(oldPath);
		this.links.set(newPath, link);
	}

	clear(): void {
		this.links.clear();
	}
}

/**
 * What a cascading delete would trash, once the `.reader` itself is already gone.
 *
 * Returned as a list rather than acted on, so the caller can check each path still exists and
 * report what it actually did. A note or file that was already moved out from under us is not
 * an error — it is simply not there to trash.
 */
export function cascadeTargets(link: DocumentLink | undefined): string[] {
	if (!link) return [];

	const paths: string[] = [];
	if (link.notePath !== "") paths.push(link.notePath);

	// A source outside the vault is not ours to delete: it was never copied in, and the person
	// who pointed Reader at it still owns it.
	if (link.sourcePath !== "" && !link.sourcePath.startsWith("/")) paths.push(link.sourcePath);

	return paths;
}
