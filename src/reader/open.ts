/**
 * Opening a document in Reader for the first time.
 *
 * Reader registers `.reader`, not `.pdf`. Claiming `.pdf` was considered and rejected against
 * the running Obsidian: `ViewRegistry.registerExtensions` throws outright for an extension
 * that is already registered —
 *
 *     if (n.hasOwnProperty(o)) throw new Error('Attempting to register an existing file extension "…"')
 *
 * — and core owns `pdf`. Releasing it first needs `app.viewRegistry.unregisterExtensions`,
 * which is not in the public typings, so owning `.pdf` would put undocumented internals in
 * the load path. Writing our own renderer to avoid depending on internals and then depending
 * on internals to launch it would be a poor trade.
 *
 * So the first open is a menu item, and it leaves behind a `.reader` file that is
 * double-clickable from then on — the same feel as a canvas.
 */

import { normalizePath, TFile, type App } from "obsidian";

import { readSourceId } from "../note/ownership";
import { createDocument, serialise, type SourceKind } from "./document";

export interface OpenTarget {
	/** Vault-relative for a file inside the vault, absolute for one outside it. */
	path: string;
	/** Filename without extension; names the pair. */
	basename: string;
	kind: SourceKind;
}

export interface CreatedPair {
	readerPath: string;
	notePath: string;
	created: boolean;
}

/** Vault paths reject these outright, and a colon silently breaks on Windows. */
function sanitise(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "document";
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (folder === "" || app.vault.getAbstractFileByPath(folder)) return;
	await app.vault.createFolder(folder).catch(() => {
		// Two clips racing, or the folder appearing between the check and the call. An
		// existing folder is the desired outcome either way.
	});
}

/**
 * The `.reader` and `.md` pair for a document, creating them if they do not exist.
 *
 * Re-opening the same document must return the *same* pair rather than making a second one,
 * or a semester of clips ends up split across `deck.md`, `deck 1.md` and `deck 2.md`. So an
 * existing `.reader` that already names this source is reused, and only a genuine collision
 * with a *different* document takes a suffix.
 */
export async function ensurePair(
	app: App,
	target: OpenTarget,
	sourcesFolder: string,
): Promise<CreatedPair> {
	await ensureFolder(app, sourcesFolder);

	const base = sanitise(target.basename);
	const prefix = sourcesFolder === "" ? "" : `${sourcesFolder}/`;

	for (let attempt = 0; attempt < 100; attempt++) {
		const suffix = attempt === 0 ? "" : ` ${attempt + 1}`;
		const readerPath = normalizePath(`${prefix}${base}${suffix}.reader`);
		const notePath = normalizePath(`${prefix}${base}${suffix}.md`);

		const existing = app.vault.getAbstractFileByPath(readerPath);

		if (existing instanceof TFile) {
			// Reuse it only if it is this same document; otherwise try the next name.
			try {
				const raw = await app.vault.read(existing);
				const stored = JSON.parse(raw) as { source?: { path?: string }; notePath?: string };
				if (stored.source?.path === target.path) {
					// The `.reader` records where its note actually is, which is not necessarily
					// where we would put it today — the user may have renamed or moved it.
					return { readerPath, notePath: stored.notePath || notePath, created: false };
				}
			} catch {
				// Unreadable or not ours: do not touch it, and do not adopt it either.
			}
			continue;
		}

		if (existing) continue; // a folder is sitting on the name

		/*
		 * The note has to be free too, not just the `.reader`.
		 *
		 * Found by opening a deck in the real app: v1's slides importer had already written
		 * `Sources/<deck>.md` and stamped it `readerSourceId`, so the pair was formed against
		 * a note Reader is not allowed to write into. The append-time ownership guard caught
		 * it correctly — but only after the document was open and a key had been pressed,
		 * which is far too late to be useful.
		 *
		 * An importer rewrites its managed regions wholesale on every sync, so adopting such
		 * a note would put clips inside a block that gets replaced, and lose them with no
		 * conflict raised. Take the next name instead.
		 */
		const noteOwner = await readSourceId(app, notePath);
		if (noteOwner !== undefined && noteOwner !== readerPath) continue;

		const document = createDocument(target.path, target.kind, notePath);
		await app.vault.create(readerPath, serialise(document));

		// The note is created empty. It gains a bullet the first time you clip, and stays a
		// perfectly ordinary markdown file that Reader only ever appends to.
		if (!app.vault.getAbstractFileByPath(notePath)) {
			await app.vault.create(notePath, "");
		}

		return { readerPath, notePath, created: true };
	}

	throw new Error(`Could not find a free name for ${base} in ${sourcesFolder}.`);
}

/** Whether Reader can open this file at all. */
export function isReadable(file: TFile): boolean {
	return kindOf(file) !== undefined;
}

/** Which reader a file needs, or undefined when Reader cannot open it. */
export function kindOf(file: TFile): SourceKind | undefined {
	switch (file.extension.toLowerCase()) {
		case "pdf":
			return "pdf";
		case "epub":
			return "epub";
		case "html":
		case "htm":
			return "html";
		default:
			return undefined;
	}
}
