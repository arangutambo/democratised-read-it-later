import { beforeEach, describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { TFile, TFolder } from "../stubs/obsidian";

import { ensurePair, isReadable } from "../../src/reader/open";

class FakeVault {
	files = new Map<string, string>();
	folders = new Set<string>();

	getAbstractFileByPath(path: string): unknown {
		if (this.folders.has(path)) return Object.assign(new TFolder(), { path });
		if (this.files.has(path)) return Object.assign(new TFile(), { path });
		return null;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async create(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async read(file: { path: string }): Promise<string> {
		return this.files.get(file.path) ?? "";
	}
}

function fakeApp(): { app: App; vault: FakeVault } {
	const vault = new FakeVault();
	// The cache is deliberately always empty: `readSourceId` treats it as a fast path and the
	// file as the authority, because getFileCache() lags behind a note written moments ago.
	const metadataCache = { getFileCache: () => null };
	return { app: { vault, metadataCache } as unknown as App, vault };
}

const DECK = { path: "Sources/_decks/w2.pdf", basename: "w2", kind: "pdf" as const };

describe("ensurePair", () => {
	let app: App;
	let vault: FakeVault;

	beforeEach(() => {
		({ app, vault } = fakeApp());
	});

	it("creates the .reader and the note together", async () => {
		const pair = await ensurePair(app, DECK, "Sources");

		expect(pair).toMatchObject({ readerPath: "Sources/w2.reader", notePath: "Sources/w2.md", created: true });
		expect(vault.files.has("Sources/w2.reader")).toBe(true);
		expect(vault.files.has("Sources/w2.md")).toBe(true);
	});

	it("points the .reader at the document and at its note", async () => {
		await ensurePair(app, DECK, "Sources");
		const doc = JSON.parse(vault.files.get("Sources/w2.reader") ?? "{}");

		expect(doc.source).toEqual({ path: "Sources/_decks/w2.pdf", kind: "pdf" });
		expect(doc.notePath).toBe("Sources/w2.md");
		expect(doc.clips).toEqual({});
	});

	it("starts the note empty, as an ordinary markdown file", async () => {
		// It gains a bullet on the first clip. Nothing is generated into it, ever.
		await ensurePair(app, DECK, "Sources");
		expect(vault.files.get("Sources/w2.md")).toBe("");
	});

	it("reuses the same pair when the document is opened again", async () => {
		// Otherwise a semester of clips ends up split across w2.md, w2 2.md and w2 3.md.
		const first = await ensurePair(app, DECK, "Sources");
		const second = await ensurePair(app, DECK, "Sources");

		expect(second.readerPath).toBe(first.readerPath);
		expect(second.created).toBe(false);
		expect(vault.files.size).toBe(2);
	});

	it("takes a new name when a different document already holds it", async () => {
		await ensurePair(app, DECK, "Sources");
		const other = await ensurePair(app, { ...DECK, path: "Sources/_decks/other.pdf" }, "Sources");

		expect(other.readerPath).toBe("Sources/w2 2.reader");
		expect(other.notePath).toBe("Sources/w2 2.md");
		expect(other.created).toBe(true);
	});

	it("does not adopt a .reader it cannot parse", async () => {
		vault.files.set("Sources/w2.reader", "{ not json");
		const pair = await ensurePair(app, DECK, "Sources");

		expect(pair.readerPath).toBe("Sources/w2 2.reader");
		// The unreadable file is left exactly as it was.
		expect(vault.files.get("Sources/w2.reader")).toBe("{ not json");
	});

	it("steps over a folder sitting on the name", async () => {
		vault.folders.add("Sources/w2.reader");
		expect((await ensurePair(app, DECK, "Sources")).readerPath).toBe("Sources/w2 2.reader");
	});

	it("steps over a note an importer already owns", async () => {
		/*
		 * Found in a real window. v1's slides importer had already written this note for the
		 * same deck and stamped it `readerSourceId`, so the pair formed against a note Reader
		 * is not allowed to write into. The append-time guard caught it — but only after the
		 * deck was open and a key had been pressed.
		 *
		 * Frontmatter below is copied verbatim from the note v1 actually left in the vault.
		 */
		vault.files.set(
			"Sources/w2.md",
			'---\ncitekey: "binf70012026week1part2andpart3slides"\n' +
				'readerState: "inbox"\nreaderType: "slides"\n' +
				'readerSourceId: "Sources/_decks/BINF7001_2026_WEEK1_Part2_and_Part3_slides.pdf"\n---\n\n# Deck\n',
		);

		const pair = await ensurePair(app, DECK, "Sources");

		expect(pair.notePath).toBe("Sources/w2 2.md");
		expect(pair.readerPath).toBe("Sources/w2 2.reader");
		// The importer's note is left exactly as it was.
		expect(vault.files.get("Sources/w2.md")).toContain("readerType: \"slides\"");
	});

	it("reuses the note path the .reader itself records", async () => {
		// The note may have been renamed since; the .reader knows where it went.
		await ensurePair(app, DECK, "Sources");
		const doc = JSON.parse(vault.files.get("Sources/w2.reader") ?? "{}");
		doc.notePath = "Sources/renamed by hand.md";
		vault.files.set("Sources/w2.reader", JSON.stringify(doc));

		expect((await ensurePair(app, DECK, "Sources")).notePath).toBe("Sources/renamed by hand.md");
	});

	it("keeps an existing note rather than blanking it", async () => {
		// Reopening a document whose note you have written in must not empty it.
		vault.files.set("Sources/w2.md", "# My notes\n\nProse I wrote.\n");
		await ensurePair(app, DECK, "Sources");

		expect(vault.files.get("Sources/w2.md")).toContain("Prose I wrote.");
	});

	it("sanitises characters a vault path cannot hold", async () => {
		// A colon breaks silently on Windows and a slash would invent a folder.
		const pair = await ensurePair(app, { ...DECK, basename: "STAT3306: Week 1/2 [draft]" }, "Sources");
		const filename = pair.readerPath.slice("Sources/".length);

		expect(pair.readerPath.startsWith("Sources/")).toBe(true);
		expect(filename).not.toMatch(/[:/[\]]/);
		expect(filename).toBe("STAT3306- Week 1-2 -draft-.reader");
	});

	it("creates the sources folder when it is missing", async () => {
		await ensurePair(app, DECK, "Sources");
		expect(vault.folders.has("Sources")).toBe(true);
	});

	it("works with no sources folder configured", async () => {
		const pair = await ensurePair(app, DECK, "");
		expect(pair.readerPath).toBe("w2.reader");
	});
});

describe("isReadable", () => {
	it("accepts a PDF whatever the case", () => {
		expect(isReadable(Object.assign(new TFile(), { extension: "pdf" }) as never)).toBe(true);
		expect(isReadable(Object.assign(new TFile(), { extension: "PDF" }) as never)).toBe(true);
	});

	it("rejects everything else for now", () => {
		// EPUB and video arrive at M7 and M8; claiming them early would offer a menu item that
		// opens a view which cannot render them.
		for (const extension of ["md", "epub", "mp4", "png", "reader"]) {
			expect(isReadable(Object.assign(new TFile(), { extension }) as never)).toBe(false);
		}
	});
});
