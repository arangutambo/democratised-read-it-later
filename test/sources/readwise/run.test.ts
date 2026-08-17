import { beforeEach, describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { TFile, TFolder } from "../../stubs/obsidian";

import { runImport } from "../../../src/sources/readwise/run";

/**
 * A minimal vault.
 *
 * Only what `runImport` touches: create, createBinary, createFolder, the path lookup and the
 * markdown listing that recognises a previous run's work.
 */
class FakeVault {
	files = new Map<string, string>();
	binaries = new Map<string, number>();
	folders = new Set<string>();
	/** Paths that refuse to be written, for the failure paths. */
	refuse = new Set<string>();

	getAbstractFileByPath(path: string): unknown {
		if (this.folders.has(path)) return Object.assign(new TFolder(), { path });
		if (this.files.has(path) || this.binaries.has(path)) return Object.assign(new TFile(), { path });
		return null;
	}

	getMarkdownFiles(): { path: string }[] {
		return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((path) => ({ path }));
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async create(path: string, data: string): Promise<void> {
		if (this.refuse.has(path)) throw new Error("refused");
		this.files.set(path, data);
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<void> {
		if (this.refuse.has(path)) throw new Error("refused");
		this.binaries.set(path, data.byteLength);
	}
}

function fakeApp(): { app: App; vault: FakeVault } {
	const vault = new FakeVault();
	return { app: { vault } as unknown as App, vault };
}

const HEADER = "Title,URL,ID,Document tags,Saved date,Reading progress,Location,Seen\n";

function csv(...rows: string[]): string {
	return HEADER + rows.join("\n") + "\n";
}

const ONE = csv("Wild Mushrooming,https://example.com,01h,[],2023-09-01,0,new,TRUE");

const FOLDERS = { sourcesFolder: "Sources", documentsFolder: "Sources/_documents" };

describe("runImport", () => {
	let app: App;
	let vault: FakeVault;

	beforeEach(() => {
		({ app, vault } = fakeApp());
	});

	it("writes a note per document", async () => {
		const summary = await runImport(app, { csv: ONE, ...FOLDERS });

		expect(summary.notes).toBe(1);
		expect(vault.files.get("Sources/Wild Mushrooming (01h).md")).toContain("readerSourceId: readwise:01h");
	});

	it("creates the folder it writes into", async () => {
		await runImport(app, { csv: ONE, ...FOLDERS });
		expect(vault.folders.has("Sources")).toBe(true);
	});

	it("creates nested folders level by level", async () => {
		// createFolder does not make parents, and the documents folder is nested by default.
		await runImport(app, {
			csv: ONE,
			sourcesFolder: "a/b/c",
			documentsFolder: "a/b/c",
		});

		expect([...vault.folders]).toContain("a/b/c");
		expect([...vault.folders]).toContain("a");
	});

	it("does not create the documents folder when nothing goes in it", async () => {
		await runImport(app, { csv: ONE, ...FOLDERS });
		expect(vault.folders.has("Sources/_documents")).toBe(false);
	});

	it("leaves the feed out", async () => {
		const summary = await runImport(app, {
			csv: csv(
				"Kept,https://example.com,01h,[],2023-09-01,0,new,TRUE",
				"Skimmed,https://example.com,02h,[],2023-09-01,0,feed,TRUE",
			),
			...FOLDERS,
		});

		expect(summary.notes).toBe(1);
		expect(summary.filteredOut).toBe(1);
	});

	it("is safe to run twice", async () => {
		/*
		 * A library this size guarantees the first attempt is interrupted, and by the second run
		 * a note may have clips and prose under it. Skipped whole, never merged, never blanked.
		 */
		await runImport(app, { csv: ONE, ...FOLDERS });
		vault.files.set("Sources/Wild Mushrooming (01h).md", "# mine now\n\nProse I wrote.\n");

		const second = await runImport(app, { csv: ONE, ...FOLDERS });

		expect(second.notes).toBe(0);
		expect(second.alreadyImported).toBe(1);
		expect(vault.files.get("Sources/Wild Mushrooming (01h).md")).toContain("Prose I wrote.");
	});

	it("reports what it would have done even with nothing to do", async () => {
		await runImport(app, { csv: ONE, ...FOLDERS });
		const second = await runImport(app, { csv: ONE, ...FOLDERS });

		expect(second.description).toContain("already imported");
	});

	it("carries on past a document it cannot write", async () => {
		// One bad row in 5,542 must not cost the other 5,541.
		vault.refuse.add("Sources/Bad (01h).md");

		const summary = await runImport(app, {
			csv: csv(
				"Bad,https://example.com,01h,[],2023-09-01,0,new,TRUE",
				"Good,https://example.com,02h,[],2023-09-01,0,new,TRUE",
			),
			...FOLDERS,
		});

		expect(summary.notes).toBe(1);
		expect(summary.failures).toEqual([{ title: "Bad", reason: "refused" }]);
	});

	it("stops when asked, keeping what it already wrote", async () => {
		let seen = 0;
		const summary = await runImport(app, {
			csv: csv(
				"One,https://example.com,01h,[],2023-09-01,0,new,TRUE",
				"Two,https://example.com,02h,[],2023-09-01,0,new,TRUE",
				"Three,https://example.com,03h,[],2023-09-01,0,new,TRUE",
			),
			...FOLDERS,
			shouldStop: () => seen++ >= 2,
		});

		expect(summary.stopped).toBe(true);
		expect(summary.notes).toBe(2);
		expect(vault.files.size).toBe(2);
	});

	it("reports progress as it goes", async () => {
		const labels: string[] = [];
		await runImport(app, {
			csv: csv(
				"One,https://example.com,01h,[],2023-09-01,0,new,TRUE",
				"Two,https://example.com,02h,[],2023-09-01,0,new,TRUE",
			),
			...FOLDERS,
			onProgress: ({ current, total, label }) => labels.push(`${current}/${total} ${label}`),
		});

		expect(labels).toEqual(["1/2 One", "2/2 Two"]);
	});

	it("writes nothing at all for an empty export", async () => {
		const summary = await runImport(app, { csv: HEADER, ...FOLDERS });

		expect(summary.notes).toBe(0);
		expect(vault.folders.size).toBe(0);
	});
});

describe("runImport with the uploaded files", () => {
	let app: App;
	let vault: FakeVault;

	beforeEach(() => {
		({ app, vault } = fakeApp());
	});

	/** A zip holding one stored (uncompressed) entry, which is all the reader needs here. */
	function zipWith(name: string, body: string): Uint8Array {
		const encoder = new TextEncoder();
		const nameBytes = encoder.encode(name);
		const data = encoder.encode(body);

		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(8, 0, true); // stored
		localView.setUint32(18, data.length, true);
		localView.setUint32(22, data.length, true);
		localView.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);

		const central = new Uint8Array(46 + nameBytes.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(10, 0, true); // stored
		centralView.setUint32(20, data.length, true);
		centralView.setUint32(24, data.length, true);
		centralView.setUint16(28, nameBytes.length, true);
		centralView.setUint32(42, 0, true); // local header offset
		central.set(nameBytes, 46);

		const end = new Uint8Array(22);
		const endView = new DataView(end.buffer);
		endView.setUint32(0, 0x06054b50, true);
		endView.setUint16(8, 1, true);
		endView.setUint16(10, 1, true);
		endView.setUint32(12, central.length, true);
		endView.setUint32(16, local.length, true);

		const out = new Uint8Array(local.length + central.length + end.length);
		out.set(local, 0);
		out.set(central, local.length);
		out.set(end, local.length + central.length);
		return out;
	}

	it("copies the document and pairs it with a .reader", async () => {
		const summary = await runImport(app, {
			csv: ONE,
			zip: zipWith("Wild Mushrooming (01h).pdf", "%PDF-1.7 pretend"),
			...FOLDERS,
		});

		expect(summary.documents).toBe(1);
		expect(summary.readers).toBe(1);
		expect(vault.binaries.has("Sources/_documents/Wild Mushrooming (01h).pdf")).toBe(true);

		const doc = JSON.parse(vault.files.get("Sources/_documents/Wild Mushrooming (01h).reader") ?? "{}");
		expect(doc.source).toEqual({ path: "Sources/_documents/Wild Mushrooming (01h).pdf", kind: "pdf" });
		expect(doc.notePath).toBe("Sources/Wild Mushrooming (01h).md");
	});

	it("points the note at the reader it made", async () => {
		await runImport(app, {
			csv: ONE,
			zip: zipWith("Wild Mushrooming (01h).pdf", "%PDF-1.7 pretend"),
			...FOLDERS,
		});

		expect(vault.files.get("Sources/Wild Mushrooming (01h).md")).toContain("Open in Reader");
	});

	it("pairs an HTML article with a .reader", async () => {
		// The case that decides whether an import is worth running: 5,479 of 5,524 files.
		const summary = await runImport(app, {
			csv: ONE,
			zip: zipWith("Wild Mushrooming (01h).html", "<h1>hi</h1>"),
			...FOLDERS,
		});

		expect(summary.documents).toBe(1);
		expect(summary.readers).toBe(1);
		expect(vault.files.get("Sources/Wild Mushrooming (01h).md")).toContain("Open in Reader");
	});

	it("still writes a link-only note for a format Reader cannot render", async () => {
		const summary = await runImport(app, {
			csv: ONE,
			zip: zipWith("Wild Mushrooming (01h).docx", "not a document"),
			...FOLDERS,
		});

		expect(summary.documents).toBe(1);
		expect(summary.readers).toBe(0);
		expect(vault.files.get("Sources/Wild Mushrooming (01h).md")).toContain("https://example.com");
	});

	it("still writes the note when the file will not extract", async () => {
		/*
		 * Downgraded to a link, not failed. The metadata is worth having on its own, and the
		 * file is still sitting in the export if you want it later.
		 */
		vault.refuse.add("Sources/_documents/Wild Mushrooming (01h).pdf");

		const summary = await runImport(app, {
			csv: ONE,
			zip: zipWith("Wild Mushrooming (01h).pdf", "%PDF-1.7 pretend"),
			...FOLDERS,
		});

		expect(summary.notes).toBe(1);
		expect(summary.readers).toBe(0);
		expect(summary.failures[0].reason).toContain("file not extracted");
		expect(vault.files.get("Sources/Wild Mushrooming (01h).md")).not.toContain("readerDocument");
	});

	it("writes a note with a link when the zip has no file for it", async () => {
		const summary = await runImport(app, {
			csv: ONE,
			zip: zipWith("Something Else (99z).pdf", "%PDF-1.7 pretend"),
			...FOLDERS,
		});

		expect(summary.notes).toBe(1);
		expect(summary.documents).toBe(0);
	});
});
