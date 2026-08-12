import { beforeEach, describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { TFile, TFolder } from "../stubs/obsidian";

import { findRegion } from "../../src/core/managed-region";
import type { ImportResult } from "../../src/core/types";
import { writeImport } from "../../src/note/writer";

/** In-memory vault: enough of the API for the writer, and nothing else. */
class FakeVault {
	files = new Map<string, string>();
	folders = new Set<string>();
	frontmatter = new Map<string, Record<string, unknown>>();

	getAbstractFileByPath(path: string): unknown {
		if (this.folders.has(path)) return Object.assign(new TFolder(), { path });
		if (this.files.has(path)) return Object.assign(new TFile(), { path });
		return null;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async create(path: string, data: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`already exists: ${path}`);
		this.files.set(path, data);
	}

	async read(file: { path: string }): Promise<string> {
		return this.files.get(file.path) ?? "";
	}

	async modify(file: { path: string }, data: string): Promise<void> {
		this.files.set(file.path, data);
	}

	getMarkdownFiles(): unknown[] {
		return [...this.files.keys()].map((path) => Object.assign(new TFile(), { path }));
	}
}

function fakeApp(): { app: App; vault: FakeVault } {
	const vault = new FakeVault();
	const app = {
		vault,
		metadataCache: {
			getFileCache: (file: { path: string }) => ({ frontmatter: vault.frontmatter.get(file.path) }),
		},
	} as unknown as App;
	return { app, vault };
}

function importResult(overrides: Partial<ImportResult["source"]> = {}, confidence = 1): ImportResult {
	return {
		source: {
			id: "ASSET1",
			sourceType: "books",
			citekey: "housel2020psychology",
			title: "The Psychology of Money",
			csl: { type: "book", title: "The Psychology of Money" },
			state: "inbox",
			...overrides,
		},
		highlights: [
			{
				id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				sourceId: "ASSET1",
				text: "Doing well with money has little to do with how smart you are.",
				created: "2024-01-01T00:00:00.000Z",
				state: "active",
				anchors: { quote: { exact: "Doing well", prefix: "", suffix: "" } },
			},
		],
		confidence,
		warnings: [],
	};
}

const options = { sourcesFolder: "Sources", confidenceThreshold: 0.6 };

describe("writeImport", () => {
	let app: App;
	let vault: FakeVault;

	beforeEach(() => {
		({ app, vault } = fakeApp());
	});

	it("creates a note with frontmatter and a managed region", async () => {
		const written = await writeImport(app, importResult(), options);

		expect(written.status).toBe("created");
		expect(written.path).toBe("Sources/The Psychology of Money.md");

		const text = vault.files.get(written.path)!;
		expect(text).toContain("citekey: housel2020psychology");
		expect(text).toContain('readerSourceId: "ASSET1"');
		expect(findRegion(text, "highlights")?.content).toContain("Doing well with money");
		expect(text).toContain("^hl-01arz3ndektsv4rrffq69g5fav");
	});

	it("creates the sources folder when it is missing", async () => {
		await writeImport(app, importResult(), { ...options, sourcesFolder: "Reading/Books" });
		expect(vault.folders.has("Reading/Books")).toBe(true);
	});

	it("marks a low-confidence import for review rather than trusting it", async () => {
		const written = await writeImport(app, importResult({}, 0.3), options);
		expect(written.needsReview).toBe(true);
		expect(vault.files.get(written.path)).toContain("readerState: needs-review");
	});

	it("re-importing unchanged highlights is a no-op", async () => {
		const first = await writeImport(app, importResult(), options);
		const before = vault.files.get(first.path);

		const second = await writeImport(app, importResult(), options);

		expect(second.status).toBe("unchanged");
		expect(vault.files.get(second.path)).toBe(before);
	});

	it("preserves prose written outside the managed region", async () => {
		const written = await writeImport(app, importResult(), options);
		const withProse = `${vault.files.get(written.path)}\n\nMy own thinking about this book.\n`;
		vault.files.set(written.path, withProse);

		const result = importResult();
		result.highlights[0].text = "A different highlight entirely.";
		await writeImport(app, result, options);

		const after = vault.files.get(written.path)!;
		expect(after).toContain("My own thinking about this book.");
		expect(after).toContain("A different highlight entirely.");
	});

	it("never overwrites a hand-edited region; it writes a conflict file", async () => {
		const written = await writeImport(app, importResult(), options);
		const tampered = vault.files.get(written.path)!.replace("Doing well with money", "I rewrote this myself");
		vault.files.set(written.path, tampered);

		const result = importResult();
		result.highlights[0].text = "New text from Apple.";
		const outcome = await writeImport(app, result, options);

		expect(outcome.status).toBe("conflict");
		expect(vault.files.get(written.path)).toBe(tampered);
		expect(outcome.conflictPath).toBe("Sources/The Psychology of Money.conflict.md");
		expect(vault.files.get(outcome.conflictPath!)).toContain("New text from Apple.");
	});

	it("gives two different books distinct notes when their titles collide", async () => {
		// Two assets missing from the Books library are both titled "Untitled"; without this
		// the second would merge into the first's note and fuse two books together.
		const first = await writeImport(app, importResult({ id: "A", title: "Untitled", citekey: "untitled" }), options);
		vault.frontmatter.set(first.path, { readerSourceId: "A" });

		const second = await writeImport(
			app,
			importResult({ id: "B", title: "Untitled", citekey: "untitleda" }),
			options,
		);

		expect(second.path).not.toBe(first.path);
		expect(second.path).toBe("Sources/Untitled (untitleda).md");
		expect(second.status).toBe("created");
	});

	it("keeps writing to the same note when the same book is re-imported", async () => {
		const first = await writeImport(app, importResult({ id: "A", title: "Untitled" }), options);
		vault.frontmatter.set(first.path, { readerSourceId: "A" });

		const second = await writeImport(app, importResult({ id: "A", title: "Untitled" }), options);

		expect(second.path).toBe(first.path);
	});
});
