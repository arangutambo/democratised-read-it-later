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

		expect(lines[position.line]).toBe("\t- ");
		expect(position.ch).toBe(3);
	});

	it("reports the writing line correctly on a note that already had content", async () => {
		vault.files.set("Sources/deck.md", "# Deck\n\nSome prose.\n");
		const position = await appendClip(app, "Sources/deck.md", clip());
		const lines = (vault.files.get("Sources/deck.md") ?? "").split("\n");

		expect(lines[position.line]).toBe("\t- ");
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

/**
 * Clipping out of order, through the real write path.
 *
 * The unit tests cover the sort; this covers the loop that actually runs — read the note,
 * insert, write it back, and do it again. That is where the writing lines were being eaten.
 */
describe("clipping out of document order", () => {
	function at(id: string, page: number, top: number, text: string): Clip {
		return {
			id,
			documentId: "d.reader",
			kind: "quote",
			created: "2026-01-01T00:00:00.000Z",
			text,
			locator: { surface: { kind: "pdf-page", index: page }, rect: [0.1, top, 0.2, 0.05] },
		};
	}

	async function clipAll(app: App, clips: Clip[]): Promise<void> {
		const seen: Record<string, Clip["locator"]> = {};
		const positionAt = (blockId: string) => {
			for (const [id, locator] of Object.entries(seen)) {
				if (id.toLowerCase() === blockId) {
					return {
						page: locator.surface.index,
						top: locator.rect?.[1] ?? 0,
						left: locator.rect?.[0] ?? 0,
					};
				}
			}
			return undefined;
		};

		for (const clip of clips) {
			await appendClip(app, "n.md", clip, { positionAt });
			seen[clip.id] = clip.locator;
		}
	}

	it("puts them in reading order however they were made", async () => {
		const { app, vault } = fakeApp();
		await clipAll(app, [
			at("AAA", 9, 0.1, "page nine"),
			at("BBB", 2, 0.1, "page two"),
			at("CCC", 5, 0.1, "page five"),
			at("DDD", 5, 0.8, "page five, lower down"),
		]);

		const body = vault.files.get("n.md") ?? "";
		const order = ["page two", "page five", "page five, lower down", "page nine"].map((t) => body.indexOf(t));

		expect(order.every((i) => i >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("leaves every clip its writing line", async () => {
		/*
		 * The insert trimmed trailing blank lines with `.trim() === ""`, which is true of the
		 * lone tab under each clip — so every insert ate the previous clip's writing line and
		 * the note degraded a little each time.
		 */
		const { app, vault } = fakeApp();
		await clipAll(app, [at("AAA", 9, 0.1, "nine"), at("BBB", 2, 0.1, "two"), at("CCC", 5, 0.1, "five")]);

		const lines = (vault.files.get("n.md") ?? "").split("\n");
		const bullets = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("- "));

		expect(bullets).toHaveLength(3);
		for (const [, i] of bullets) expect(lines[i + 1]).toBe("\t- ");
	});

	it("keeps prose written under a clip attached to it", async () => {
		const { app, vault } = fakeApp();
		await clipAll(app, [at("AAA", 9, 0.1, "nine")]);

		// Write under the first clip, the way you would while reading.
		const withProse = (vault.files.get("n.md") ?? "").replace("\t- ", "\t- my working for page nine");
		vault.files.set("n.md", withProse);

		await appendClip(app, "n.md", at("BBB", 2, 0.1, "two"), {
			positionAt: (id) => (id === "aaa" ? { page: 9, top: 0.1, left: 0.1 } : undefined),
		});

		const lines = (vault.files.get("n.md") ?? "").split("\n");
		const nine = lines.findIndex((l) => l.includes("nine"));

		expect(lines[nine + 1]).toBe("\t- my working for page nine");
	});
});
