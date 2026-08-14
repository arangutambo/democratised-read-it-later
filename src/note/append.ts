/**
 * Appending a clip to its note.
 *
 * The only writer in the capture path, and it can only append. There is deliberately no code
 * here that replaces existing content, which is what makes the capture note safe without any
 * managed-region or conflict machinery: the plugin cannot clobber a hand-edit because it has
 * no way to express one.
 *
 * The one guard that matters is ownership. v1 shipped a bug where two sources wrote to one
 * note and one silently replaced the other's content; the rule was then learned in the Books
 * importer and rebuilt without it in the slides importer. So it is enforced here rather than
 * remembered — a capture note and an importer-owned note are never the same file.
 */

import { TFile, type App } from "obsidian";

import { appendBullet, type BulletOptions } from "./bullet";
import { readSourceId } from "./ownership";
import type { Clip } from "../capture/types";

export class NoteOwnershipError extends Error {}

export interface AppendOptions extends BulletOptions {
	/**
	 * Where the cursor should end up. The view uses this to put focus on the writing line
	 * under the clip that was just made, which is the difference between "a clip landed
	 * somewhere" and "I can type now".
	 */
	onAppended?: (position: { line: number; ch: number }) => void;
}

/**
 * Append one clip to the note at `notePath`, creating it if it does not exist.
 *
 * Returns the position of the indented writing line beneath the new bullet.
 */
export async function appendClip(
	app: App,
	notePath: string,
	clip: Clip,
	options: AppendOptions = {},
): Promise<{ line: number; ch: number }> {
	const existing = app.vault.getAbstractFileByPath(notePath);

	if (existing !== null && !(existing instanceof TFile)) {
		throw new NoteOwnershipError(`${notePath} is a folder, not a note.`);
	}

	if (existing instanceof TFile) {
		/*
		 * An importer stamps `readerSourceId` into a note's frontmatter and rewrites its
		 * managed regions wholesale on every sync. Appending clips into such a note would put
		 * hand-made content inside a region that gets replaced, and it would be lost on the
		 * next import with no conflict raised — the region's hash would match, because the
		 * importer wrote it.
		 */
		const owner = await readSourceId(app, notePath);
		if (owner !== undefined && owner !== clip.documentId) {
			throw new NoteOwnershipError(
				`${notePath} already belongs to another source. Reader will not write into it — ` +
					`open the document from a different note, or move that note aside.`,
			);
		}
	}

	const body = existing instanceof TFile ? await app.vault.read(existing) : "";
	const next = appendBullet(body, clip, options);

	if (existing instanceof TFile) await app.vault.modify(existing, next);
	else await app.vault.create(notePath, next);

	// The bullet is two lines: the clip, then the indented writing line. The cursor belongs
	// on the second, after the tab.
	const lines = next.split("\n");
	// `next` always ends with a newline, so the writing line is the second from last entry.
	const line = Math.max(lines.length - 2, 0);
	const position = { line, ch: lines[line]?.length ?? 0 };

	options.onAppended?.(position);
	return position;
}
