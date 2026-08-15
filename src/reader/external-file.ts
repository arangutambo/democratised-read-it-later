/**
 * Reading a document that lives outside the vault.
 *
 * This module exists to be *lazily imported by other local modules*, which is the only shape
 * that works. esbuild compiles a **static** import of an external module into `require()`,
 * which Electron resolves natively; a **dynamic** `await import("node:fs/promises")` survives
 * as a real ESM import, which the renderer treats as a URL fetch and Obsidian's
 * `app://obsidian.md` origin turns into a CORS failure. That reached a real window once.
 *
 * So the node builtin is imported statically here, and callers defer the cost with
 * `await import("./external-file")` — deferring the *local* module, never the builtin.
 * `test/architecture.test.ts` asserts nothing in `src/` ever imports `node:` dynamically.
 */

import { readFile, stat } from "node:fs/promises";

export class ExternalFileError extends Error {}

/** Refuse anything absurd before allocating for it. 512 MB is far past any real document. */
const MAX_BYTES = 512 * 1024 * 1024;

export async function readExternalFile(path: string): Promise<Uint8Array> {
	let size: number;
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new ExternalFileError(`${path} is not a file.`);
		size = info.size;
	} catch (error) {
		if (error instanceof ExternalFileError) throw error;
		throw new ExternalFileError(
			`Could not read ${path}. It may have been moved, renamed or deleted since it was opened in Reader.`,
		);
	}

	if (size > MAX_BYTES) {
		throw new ExternalFileError(
			`${path} is ${Math.round(size / 1024 / 1024)} MB, which is too large for Reader to open.`,
		);
	}

	const buffer = await readFile(path);
	// A Node Buffer is a view over a pooled ArrayBuffer, and pdf.js both rejects Buffers and
	// detaches what it is given. Copy into memory we own outright.
	const bytes = new Uint8Array(buffer.byteLength);
	bytes.set(buffer);
	return bytes;
}
