/**
 * Reading slide decks from a folder outside the vault. Desktop only.
 *
 * Separate from `import.ts` for two reasons, and the second one is a bug that reached a real
 * Obsidian window:
 *
 * 1. `import.ts` must stay free of node builtins so importing a PDF that already lives in the
 *    vault works on mobile too. Only the bulk-from-a-folder path needs the filesystem.
 * 2. **Node builtins must be imported statically, never with `await import()`.** esbuild
 *    compiles a *static* import of an external module into `require("node:fs/promises")`,
 *    which Electron's renderer resolves natively. It leaves a *dynamic* `import()` as a real
 *    ESM import expression, which the renderer treats as a URL fetch — and Obsidian's
 *    `app://obsidian.md` origin makes that a CORS failure:
 *
 *      Access to script at 'node:fs/promises' from origin 'app://obsidian.md' has been
 *      blocked by CORS policy
 *
 *    The module is instead kept node-only and *this whole file* is lazily imported, which
 *    defers evaluation just as effectively without the broken import form.
 *
 * `test/architecture.test.ts` fails the build if `await import("node:…")` reappears anywhere.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface DeckFile {
	data: ArrayBuffer;
	fileName: string;
}

export class DeckInboxError extends Error {}

/**
 * How deep to look for PDFs.
 *
 * People organise a downloads folder — "Lecture Slides", "Course Materials" — and a reader
 * that only looks at the top level reports "no PDFs" while staring at twenty of them. Three
 * levels covers any sane arrangement without walking an entire drive.
 */
const MAX_DEPTH = 3;

function describe(error: unknown, folder: string): Error {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return new DeckInboxError(`No such folder: ${folder}`);
	if (code === "EACCES" || code === "EPERM") {
		return new DeckInboxError(
			`macOS blocked Reader from reading ${folder}. Grant Obsidian access to that folder ` +
				`in System Settings → Privacy & Security, or move the PDFs somewhere else.`,
		);
	}
	return error as Error;
}

/** Paths of every PDF under `folder`, including subfolders, in a stable order. */
export async function findPdfs(folder: string, depth = MAX_DEPTH): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(folder, { withFileTypes: true });
	} catch (error) {
		throw describe(error, folder);
	}

	const files: string[] = [];
	const directories: string[] = [];

	for (const entry of entries) {
		// Skip dotfolders and macOS bundles; nothing a reader filed away lives in them.
		if (entry.name.startsWith(".")) continue;
		const full = path.join(folder, entry.name);
		if (entry.isDirectory()) directories.push(full);
		else if (entry.name.toLowerCase().endsWith(".pdf")) files.push(full);
	}

	files.sort();
	directories.sort();

	if (depth > 1) {
		for (const directory of directories) {
			// A subfolder we cannot read should not abort the whole import.
			try {
				files.push(...(await findPdfs(directory, depth - 1)));
			} catch {
				continue;
			}
		}
	}

	return files;
}

/** Every PDF under `folder`, read into memory. */
export async function readExternalPdfs(folder: string): Promise<DeckFile[]> {
	const paths = await findPdfs(folder);
	const out: DeckFile[] = [];

	for (const file of paths) {
		const buffer = await readFile(file);
		out.push({
			// Node may hand back a view into a larger pooled buffer; slice to just this file.
			data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
			fileName: path.basename(file),
		});
	}

	return out;
}
