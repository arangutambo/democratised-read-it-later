import { describe, expect, it } from "vitest";

import {
	countsByState,
	filterEntries,
	nextToOpen,
	ofState,
	sortEntries,
	stateOf,
	subtitleOf,
	titleOf,
	toEntry,
	type LibraryEntry,
} from "../../src/library/model";
import { createDocument, type ReaderDocument } from "../../src/reader/document";

function doc(overrides: Partial<ReaderDocument> = {}): ReaderDocument {
	return { ...createDocument("Sources/_decks/w2.pdf", "pdf", "Sources/w2.md"), ...overrides };
}

describe("titleOf", () => {
	it("takes the filename without folder or extension", () => {
		expect(titleOf("Sources/Workbook 2026.reader")).toBe("Workbook 2026");
	});
});

describe("stateOf", () => {
	it("calls an untouched document unread", () => {
		expect(stateOf(1, 142, 0)).toBe("unread");
	});

	it("calls a document with clips reading, even on page one", () => {
		// You clipped the first page and stopped; that is started, not untouched.
		expect(stateOf(1, 142, 3)).toBe("reading");
	});

	it("calls a document you have moved through reading", () => {
		expect(stateOf(40, 142, 0)).toBe("reading");
	});

	it("calls a document you have reached the end of finished", () => {
		expect(stateOf(142, 142, 9)).toBe("finished");
	});

	it("never calls a document finished when the length is unknown", () => {
		// The page count is only learned once something has opened the document.
		expect(stateOf(40, undefined, 0)).toBe("reading");
	});
});

describe("toEntry", () => {
	it("derives progress as a fraction of the page count", () => {
		const entry = toEntry({
			path: "Sources/w.reader",
			document: doc({ view: { surface: 71, zoom: 1, scroll: 0 } }),
			modified: 0,
			pages: 142,
		});

		expect(entry.progress).toBeCloseTo(0.5, 3);
	});

	it("has no progress until the page count is known", () => {
		const entry = toEntry({ path: "w.reader", document: doc(), modified: 0 });
		expect(entry.progress).toBeUndefined();
	});

	it("counts the clips", () => {
		const entry = toEntry({
			path: "w.reader",
			document: doc({ clips: { a: { surface: { kind: "pdf-page", index: 1 } } } }),
			modified: 0,
		});

		expect(entry.clips).toBe(1);
	});

	it("never reports progress above one, however the position was recorded", () => {
		const entry = toEntry({
			path: "w.reader",
			document: doc({ view: { surface: 900, zoom: 1, scroll: 0 } }),
			modified: 0,
			pages: 142,
		});

		expect(entry.progress).toBe(1);
	});
});

describe("sortEntries", () => {
	const entries = [
		{ title: "Beta", modified: 100, progress: 0.2 },
		{ title: "alpha", modified: 300, progress: undefined },
		{ title: "Gamma", modified: 200, progress: 0.9 },
	] as LibraryEntry[];

	it("puts the most recent first by default", () => {
		expect(sortEntries(entries, "recent").map((e) => e.title)).toEqual(["alpha", "Gamma", "Beta"]);
	});

	it("sorts titles case-insensitively", () => {
		expect(sortEntries(entries, "title").map((e) => e.title)).toEqual(["alpha", "Beta", "Gamma"]);
	});

	it("puts the furthest through first, and the unstarted last", () => {
		// Unstarted must not tie with zero progress; it belongs at the bottom of the shelf.
		expect(sortEntries(entries, "progress").map((e) => e.title)).toEqual(["Gamma", "Beta", "alpha"]);
	});

	it("does not mutate what it was given", () => {
		const original = [...entries];
		sortEntries(entries, "title");
		expect(entries).toEqual(original);
	});
});

describe("filterEntries", () => {
	const entries = [
		{ title: "Workbook 2026", sourcePath: "pages/Assets/Workbook 2026.pdf" },
		{ title: "Week 2 slides", sourcePath: "Sources/_decks/BINF7001_WEEK2.pdf" },
	] as LibraryEntry[];

	it("matches the title", () => {
		expect(filterEntries(entries, "workbook")).toHaveLength(1);
	});

	it("matches the source path, so a renamed note is still findable", () => {
		expect(filterEntries(entries, "binf")[0].title).toBe("Week 2 slides");
	});

	it("returns everything for an empty query", () => {
		expect(filterEntries(entries, "  ")).toHaveLength(2);
	});
});

describe("subtitleOf", () => {
	it("reads as position and yield", () => {
		expect(subtitleOf({ page: 71, pages: 142, clips: 9 } as LibraryEntry)).toBe("p71 of 142 · 9 clips");
	});

	it("says nothing about an untouched document", () => {
		expect(subtitleOf({ page: 1, clips: 0 } as LibraryEntry)).toBe("");
	});

	it("keeps the singular singular", () => {
		expect(subtitleOf({ page: 1, clips: 1 } as LibraryEntry)).toBe("1 clip");
	});
});

/** An entry in a given reading state, built the way the shelf actually builds one. */
function entry(o: { page: number; pages?: number; clips: number }): LibraryEntry {
	const clips: Record<string, unknown> = {};
	for (let i = 0; i < o.clips; i++) clips[`c${i}`] = { surface: { kind: "pdf-page", index: 1 } };

	return toEntry({
		path: `Sources/${o.page}-${o.clips}.reader`,
		document: doc({ view: { surface: o.page, zoom: 1, scroll: 0 }, clips: clips as never }),
		modified: 0,
		pages: o.pages,
	});
}

describe("countsByState", () => {
	it("counts each state", () => {
		/*
		 * The shelf leads with these because a Readwise import lands ~2,100 documents at once,
		 * and "2,088 things" is not a fact you can act on. "12 reading" is.
		 */
		const entries = [
			entry({ page: 1, clips: 0 }),
			entry({ page: 4, clips: 2 }),
			entry({ page: 10, pages: 10, clips: 1 }),
		];

		expect(countsByState(entries)).toEqual({ unread: 1, reading: 1, finished: 1 });
	});

	it("is all zeroes for an empty shelf", () => {
		expect(countsByState([])).toEqual({ unread: 0, reading: 0, finished: 0 });
	});
});

describe("ofState", () => {
	it("keeps only the state asked for", () => {
		const entries = [entry({ page: 1, clips: 0 }), entry({ page: 4, clips: 2 })];

		expect(ofState(entries, "unread")).toHaveLength(1);
		expect(ofState(entries, "reading")).toHaveLength(1);
	});

	it("passes everything through for 'all'", () => {
		const entries = [entry({ page: 1, clips: 0 }), entry({ page: 4, clips: 2 })];
		expect(ofState(entries, "all")).toHaveLength(2);
	});
});

describe("nextToOpen", () => {
	const at = (path: string, modified: number, e: { page: number; pages?: number; clips: number }) => ({
		...entry(e),
		path,
		modified,
	});

	it("continues with the most recently touched thing in progress", () => {
		// What you put down and meant to come back to.
		const entries = [
			at("old.reader", 100, { page: 4, clips: 1 }),
			at("recent.reader", 900, { page: 9, clips: 2 }),
		];

		expect(nextToOpen(entries, "reading")?.path).toBe("recent.reader");
	});

	it("takes the oldest unread, so the queue drains from the bottom", () => {
		/*
		 * Newest-first would mean the same handful forever after an import of 2,000 documents,
		 * and everything saved before it would never surface.
		 */
		const entries = [
			at("new.reader", 900, { page: 1, clips: 0 }),
			at("old.reader", 100, { page: 1, clips: 0 }),
		];

		expect(nextToOpen(entries, "unread")?.path).toBe("old.reader");
	});

	it("never offers the one already open", () => {
		// Otherwise "next" means "this one" forever.
		const entries = [at("open.reader", 900, { page: 4, clips: 1 })];
		expect(nextToOpen(entries, "reading", "open.reader")).toBeUndefined();
	});

	it("ignores documents in another state", () => {
		const entries = [at("done.reader", 900, { page: 10, pages: 10, clips: 1 })];

		expect(nextToOpen(entries, "reading")).toBeUndefined();
		expect(nextToOpen(entries, "unread")).toBeUndefined();
	});

	it("is undefined for an empty shelf", () => {
		expect(nextToOpen([], "unread")).toBeUndefined();
	});
});
