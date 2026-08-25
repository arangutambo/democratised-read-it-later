/**
 * Dropping files onto the shelf.
 *
 * Dragging a PDF from the desktop onto the library is the shortest path there is from "I have
 * this" to "I am reading this", and it is the one gesture the shelf was missing: everything
 * else needed the file to already be in the vault and then a right-click.
 *
 * The decisions here are the ones worth testing, and none of them need a browser: what may be
 * dropped, and where it lands without overwriting anything. The event plumbing lives in the
 * view and the writing lives in the plugin; this is the part that has to be right.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { SourceKind } from "../reader/document";
import { kindForExtension } from "../reader/open";

export interface DropCandidate {
	/** The filename as dropped, extension and all. */
	name: string;
	kind: SourceKind;
}

export interface Triage {
	accepted: DropCandidate[];
	/** Names Reader cannot open, kept so the shelf can say which rather than fail silently. */
	rejected: string[];
}

/** The name split at its last dot, which is where an extension is. */
export function splitName(name: string): { base: string; extension: string } {
	const trimmed = name.trim();
	const dot = trimmed.lastIndexOf(".");

	// A leading dot is a hidden file, not an extension: ".gitignore" has no base otherwise.
	if (dot <= 0) return { base: trimmed, extension: "" };
	return { base: trimmed.slice(0, dot), extension: trimmed.slice(dot + 1) };
}

/** The kind Reader would use for a dropped filename, or undefined when it cannot open it. */
export function kindForDropped(name: string): SourceKind | undefined {
	return kindForExtension(splitName(name).extension);
}

/**
 * Sort what was dropped into what can be read and what cannot.
 *
 * Order is preserved because it is the order they were dropped in, and a person who drops five
 * things and gets four expects to be told which one is missing.
 */
export function triage(names: readonly string[]): Triage {
	const accepted: DropCandidate[] = [];
	const rejected: string[] = [];

	for (const name of names) {
		const kind = kindForDropped(name);
		if (kind) accepted.push({ name: name.trim(), kind });
		else rejected.push(name.trim());
	}

	return { accepted, rejected };
}

/** Characters a vault path will not take. Mirrors `reader/open.ts`, for the same reasons. */
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

/** A filename a vault will accept, without losing what the file was called. */
export function safeName(name: string): string {
	const cleaned = name.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
	return cleaned === "" ? "Document" : cleaned.slice(0, 120);
}

/**
 * A path in `folder` that nothing occupies.
 *
 * Dropping the same file twice is a thing people do — the second one is a new document, not an
 * overwrite of the first, because the first may already have highlights hanging off it.
 */
export function freePathFor(
	folder: string,
	name: string,
	taken: (path: string) => boolean,
): string {
	const { base, extension } = splitName(name);
	const suffix = extension === "" ? "" : `.${extension}`;
	const prefix = folder === "" ? "" : `${folder}/`;
	const stem = safeName(base);

	for (let n = 1; n < 200; n++) {
		const candidate = `${prefix}${stem}${n === 1 ? "" : ` ${n}`}${suffix}`;
		if (!taken(candidate)) return candidate;
	}

	return `${prefix}${stem} ${Date.now()}${suffix}`;
}
