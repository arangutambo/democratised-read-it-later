import { describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { TFile } from "../stubs/obsidian";

import { collectQueue, ensureQueueBase, queueBaseContent, QUEUE_FILENAME } from "../../src/review/queue";

interface Note {
	path: string;
	frontmatter?: Record<string, unknown>;
}

function fakeApp(notes: Note[]) {
	const created = new Map<string, string>();
	const app = {
		vault: {
			getMarkdownFiles: () =>
				notes.map((n) =>
					Object.assign(new TFile(), {
						path: n.path,
						basename: n.path.split("/").pop()!.replace(/\.md$/, ""),
					}),
				),
			getAbstractFileByPath: (path: string) =>
				created.has(path) ? Object.assign(new TFile(), { path }) : null,
			create: async (path: string, data: string) => {
				created.set(path, data);
			},
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => ({
				frontmatter: notes.find((n) => n.path === file.path)?.frontmatter,
			}),
		},
	} as unknown as App;

	return { app, created };
}

describe("collectQueue", () => {
	it("finds notes flagged for review", () => {
		const { app } = fakeApp([
			{ path: "Sources/Good.md", frontmatter: { readerState: "inbox" } },
			{ path: "Sources/Thin.md", frontmatter: { readerState: "needs-review" } },
		]);

		const summary = collectQueue(app, "Sources");

		expect(summary.needsReview).toBe(1);
		expect(summary.entries.map((e) => e.title)).toEqual(["Thin"]);
	});

	it("counts orphaned highlights across notes", () => {
		const { app } = fakeApp([
			{ path: "Sources/A.md", frontmatter: { readerState: "inbox", readerOrphans: 3 } },
			{ path: "Sources/B.md", frontmatter: { readerState: "inbox", readerOrphans: 0 } },
			{ path: "Sources/C.md", frontmatter: { readerState: "inbox", readerOrphans: 5 } },
		]);

		const summary = collectQueue(app, "Sources");

		expect(summary.orphans).toBe(8);
		expect(summary.entries).toHaveLength(2);
	});

	it("picks up conflict files", () => {
		const { app } = fakeApp([{ path: "Sources/Book.conflict.md" }]);

		const summary = collectQueue(app, "Sources");

		expect(summary.conflicts).toBe(1);
		expect(summary.entries[0].reason).toBe("conflict");
	});

	it("reports a note that is both thin and orphaned under both reasons", () => {
		const { app } = fakeApp([
			{ path: "Sources/Bad.md", frontmatter: { readerState: "needs-review", readerOrphans: 2 } },
		]);

		const summary = collectQueue(app, "Sources");

		expect(summary.needsReview).toBe(1);
		expect(summary.orphans).toBe(2);
		expect(summary.entries.map((e) => e.reason).sort()).toEqual(["needs-review", "orphans"]);
	});

	it("ignores notes outside the sources folder", () => {
		// A 5,105-note vault must not have unrelated notes dragged into the queue.
		const { app } = fakeApp([
			{ path: "Journal/Daily.md", frontmatter: { readerState: "needs-review" } },
			{ path: "Sources/Real.md", frontmatter: { readerState: "needs-review" } },
		]);

		expect(collectQueue(app, "Sources").entries.map((e) => e.title)).toEqual(["Real"]);
	});

	it("ignores notes with no frontmatter", () => {
		const { app } = fakeApp([{ path: "Sources/Plain.md" }]);
		expect(collectQueue(app, "Sources").entries).toEqual([]);
	});

	it("returns an empty summary for an empty vault", () => {
		const { app } = fakeApp([]);
		expect(collectQueue(app, "Sources")).toMatchObject({ needsReview: 0, orphans: 0, conflicts: 0 });
	});
});

describe("ensureQueueBase", () => {
	it("creates the base when missing", async () => {
		const { app, created } = fakeApp([]);

		const result = await ensureQueueBase(app, "Sources");

		expect(result.created).toBe(true);
		expect(result.path).toBe(`Sources/${QUEUE_FILENAME}`);
		expect(created.get(result.path)).toContain("views:");
	});

	it("never overwrites an existing base", async () => {
		// The user will have customised their views; clobbering them would be the same sin
		// the managed-region rules exist to prevent, in a different file.
		const { app, created } = fakeApp([]);
		await ensureQueueBase(app, "Sources");
		created.set(`Sources/${QUEUE_FILENAME}`, "views: [] # mine");

		const second = await ensureQueueBase(app, "Sources");

		expect(second.created).toBe(false);
		expect(created.get(second.path)).toBe("views: [] # mine");
	});
});

describe("queueBaseContent", () => {
	it("filters on top-level properties, which is what Bases expressions address", () => {
		const content = queueBaseContent();

		expect(content).toContain('readerState == "needs-review"');
		expect(content).toContain("readerOrphans > 0");
		// Nested access would be `reader.state`, which is exactly what the flat frontmatter
		// shape exists to avoid relying on.
		expect(content).not.toContain("reader.state");
	});

	it("defines the views the queue needs", () => {
		const content = queueBaseContent();
		for (const name of ["Needs review", "Reading", "Inbox", "Everything"]) {
			expect(content).toContain(`name: ${name}`);
		}
	});
});
