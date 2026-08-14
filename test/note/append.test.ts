import { beforeEach, describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { TFile, TFolder } from "../stubs/obsidian";

import { appendClip, NoteOwnershipError } from "../../src/note/append";
import type { Clip } from "../../src/capture/types";

/** In-memory vault: enough of the API for the appender, and nothing else. */
class FakeVault {
	files = new Map<string, string>();
	folders = new Set<string>();

	getAbstractFileByPath(path: string): unknown {
		if (this.folders.has(path)) return Object.assign(new TFolder(), { path });
		if (this.files.has(path)) return Object.assign(new TFile(), { path });
		return null;
	}

	async create(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async read(file: { path: string }): Promise<string> {
		return this.files.get(file.path) ?? "";
	}

	async modify(file: { path: string }, data: string): Promise<void> {
		this.files.set(file.path, data);
	}
}

function fakeApp(): { app: App; vault: FakeVault } {
	const vault = new FakeVault();
	const app = {
		vault,
		metadataCache: { getFileCache: () => null },
	} as unknown as App;
	return { app, vault };
}

let n = 0;
function clip(overrides: Partial<Clip> = {}): Clip {
	n += 1;
	return {
		id: `01K9${String(n).padStart(22, "0")}`,
		documentId: "doc-1",
		kind: "quote",
		created: "2026-08-14T04:00:00.000Z",
		text: `quote ${n}`,
		locator: { surface: { kind: "pdf-page", index: 1 } },
		...overrides,
	};
}

describe("appendClip", () => {
	let app: App;
	let vault: FakeVault;

	beforeEach(() => {
		({ app, vault } = fakeApp());
		n = 0;
	});

	it("creates the note when it does not exist yet", async () => {
		await appendClip(app, "Sources/deck.md", clip());

		expect(vault.files.has("Sources/deck.md")).toBe(true);
		expect(vault.files.get("Sources/deck.md")).toContain("> quote 1");
	});

	it("appends to an existing note without touching what is there", async () => {
		vault.files.set("Sources/deck.md", "# Deck\n\nProse I wrote by hand.\n");
		await appendClip(app, "Sources/deck.md", clip());

		const body = vault.files.get("Sources/deck.md") ?? "";
		expect(body).toContain("Prose I wrote by hand.");
		expect(body.indexOf("Prose I wrote")).toBeLessThan(body.indexOf("> quote 1"));
	});

	it("accumulates clips in capture order", async () => {
		await appendClip(app, "Sources/deck.md", clip());
		await appendClip(app, "Sources/deck.md", clip());
		await appendClip(app, "Sources/deck.md", clip());

		const body = vault.files.get("Sources/deck.md") ?? "";
		expect(body.indexOf("quote 1")).toBeLessThan(body.indexOf("quote 2"));
		expect(body.indexOf("quote 2")).toBeLessThan(body.indexOf("quote 3"));
	});

	it("returns the writing line under the new bullet, not the bullet itself", async () => {
		// The cursor has to land where you type, or the gesture stops halfway.
		const position = await appendClip(app, "Sources/deck.md", clip());
		const lines = (vault.files.get("Sources/deck.md") ?? "").split("\n");

		expect(lines[position.line]).toBe("\t");
		expect(position.ch).toBe(1);
	});

	it("reports the writing line correctly on a note that already had content", async () => {
		vault.files.set("Sources/deck.md", "# Deck\n\nSome prose.\n");
		const position = await appendClip(app, "Sources/deck.md", clip());
		const lines = (vault.files.get("Sources/deck.md") ?? "").split("\n");

		expect(lines[position.line]).toBe("\t");
	});

	it("refuses to write into a note owned by an importer", async () => {
		/*
		 * v1 shipped this bug twice: two sources writing to one note, the second silently
		 * replacing the first. An importer rewrites its managed regions wholesale, so clips
		 * appended into such a note would vanish on the next sync with no conflict raised.
		 */
		vault.files.set(
			"Sources/deck.md",
			'---\nreaderSourceId: "books:some-other-source"\n---\n\n# A book\n',
		);

		await expect(appendClip(app, "Sources/deck.md", clip())).rejects.toThrow(NoteOwnershipError);
		expect(vault.files.get("Sources/deck.md")).not.toContain("quote 1");
	});

	it("allows writing into a note this same document already owns", async () => {
		vault.files.set("Sources/deck.md", '---\nreaderSourceId: "doc-1"\n---\n\n# The deck\n');
		await appendClip(app, "Sources/deck.md", clip());

		expect(vault.files.get("Sources/deck.md")).toContain("quote 1");
	});

	it("refuses when the path is a folder", async () => {
		vault.folders.add("Sources/deck.md");
		await expect(appendClip(app, "Sources/deck.md", clip())).rejects.toThrow(NoteOwnershipError);
	});

	it("writes an image clip as a plain embed", async () => {
		await appendClip(
			app,
			"Sources/deck.md",
			clip({ kind: "image", text: undefined, assetPath: "Sources/_assets/d/p3-a1.png" }),
		);

		const body = vault.files.get("Sources/deck.md") ?? "";
		expect(body).toContain("![[Sources/_assets/d/p3-a1.png]]");
		expect(body).not.toContain("page=");
	});
});
