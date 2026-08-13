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

/** Every PDF in `folder`, in name order, read into memory. */
export async function readExternalPdfs(folder: string): Promise<DeckFile[]> {
	let entries: string[];
	try {
		entries = await readdir(folder);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new DeckInboxError(`No such folder: ${folder}`);
		if (code === "EACCES" || code === "EPERM") {
			throw new DeckInboxError(
				`macOS blocked Reader from reading ${folder}. Grant Obsidian access to that folder ` +
					`in System Settings → Privacy & Security, or move the decks somewhere else.`,
			);
		}
		throw error;
	}

	const pdfs = entries.filter((entry) => entry.toLowerCase().endsWith(".pdf")).sort();
	const out: DeckFile[] = [];

	for (const entry of pdfs) {
		const buffer = await readFile(path.join(folder, entry));
		out.push({
			// Node may hand back a view into a larger pooled buffer; slice to just this file.
			data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
			fileName: entry,
		});
	}

	return out;
}
