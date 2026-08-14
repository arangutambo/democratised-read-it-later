import { describe, expect, it } from "vitest";

import {
	blockIdsIn,
	createDocument,
	parseDocument,
	reconcile,
	ReaderDocumentError,
	serialise,
	type ReaderDocument,
} from "../../src/reader/document";

function doc(clips: ReaderDocument["clips"] = {}): ReaderDocument {
	return { ...createDocument("Sources/_decks/w2.pdf", "pdf", "Sources/w2.md"), clips };
}

const pageLocator = (index: number) => ({ surface: { kind: "pdf-page" as const, index } });

describe("round trip", () => {
	it("survives serialise → parse unchanged", () => {
		const original = doc({
			"01k9aaa": { surface: { kind: "pdf-page", index: 12 }, rect: [0.1, 0.2, 0.3, 0.4] },
			"01k9bbb": {
				surface: { kind: "pdf-page", index: 3 },
				quote: { exact: "a claim", prefix: "before ", suffix: " after" },
			},
		});

		expect(parseDocument(serialise(original)).document).toEqual(original);
	});

	it("re-serialising an unchanged document produces an identical file", () => {
		// This file is in a synced vault. A save that reorders keys makes every reopen a diff.
		const once = serialise(doc({ "01k9aaa": pageLocator(1) }));
		expect(serialise(parseDocument(once).document)).toBe(once);
	});

	it("ends with a newline", () => {
		expect(serialise(doc()).endsWith("\n")).toBe(true);
	});
});

describe("parseDocument", () => {
	it("rejects malformed JSON with a readable message", () => {
		expect(() => parseDocument("{not json")).toThrow(ReaderDocumentError);
	});

	it("rejects a file that names no document", () => {
		expect(() => parseDocument('{"version":1,"source":{}}')).toThrow(ReaderDocumentError);
	});

	it("drops an unreadable mark rather than failing the whole document", () => {
		// The clip's words are in the note and are unaffected; only the mark is lost. Throwing
		// would let one bad entry take a whole semester's deck down with it.
		const raw = JSON.stringify({
			version: 1,
			source: { path: "a.pdf", kind: "pdf" },
			notePath: "a.md",
			clips: { good: pageLocator(1), bad: { surface: { kind: "nonsense", index: 1 } }, alsoBad: 42 },
		});

		const { document, warnings } = parseDocument(raw);

		expect(Object.keys(document.clips)).toEqual(["good"]);
		expect(warnings.join(" ")).toMatch(/2 mark\(s\) could not be read/);
	});

	it("preserves fields written by a newer version instead of destroying them", () => {
		const raw = JSON.stringify({
			version: 99,
			source: { path: "a.pdf", kind: "pdf" },
			notePath: "a.md",
			clips: {},
			somethingNew: { nested: true },
		});

		const { document, warnings } = parseDocument(raw);

		expect(document).toHaveProperty("somethingNew", { nested: true });
		expect(warnings.join(" ")).toMatch(/newer version/i);
	});

	it("clamps a hand-edited view rather than trusting it", () => {
		const raw = JSON.stringify({
			version: 1,
			source: { path: "a.pdf", kind: "pdf" },
			notePath: "a.md",
			view: { surface: -5, zoom: 900, scroll: 4 },
		});

		expect(parseDocument(raw).document.view).toEqual({ surface: 1, zoom: 8, scroll: 1 });
	});

	it("falls back to pdf for an unrecognised source kind", () => {
		const raw = '{"version":1,"source":{"path":"a.pdf","kind":"papyrus"},"notePath":"a.md"}';
		expect(parseDocument(raw).document.source.kind).toBe("pdf");
	});
});

describe("blockIdsIn", () => {
	it("finds the ids the note carries", () => {
		const note = "- > a quote ^hl-01k9aaa\n\tmy prose\n\n- ![[x.png]] ^hl-01k9bbb\n\t\n";
		expect(blockIdsIn(note)).toEqual(new Set(["01k9aaa", "01k9bbb"]));
	});

	it("ignores block ids that are not ours", () => {
		expect(blockIdsIn("some text ^my-own-anchor\n")).toEqual(new Set());
	});

	it("is case-insensitive, since the note can be hand-edited", () => {
		expect(blockIdsIn("x ^hl-01K9AAA")).toEqual(new Set(["01k9aaa"]));
	});
});

/**
 * PLAN-V2 §4.1, exhaustively. This is decision F — "the note wins, nothing ever resurrects"
 * — and it is the rule most likely to be quietly broken by a later convenience.
 */
describe("reconcile", () => {
	it("keeps a mark the note still refers to", () => {
		const result = reconcile(doc({ "01k9aaa": pageLocator(1) }), "- > q ^hl-01k9aaa\n\t\n");

		expect(Object.keys(result.document.clips)).toEqual(["01k9aaa"]);
		expect(result.changed).toBe(false);
	});

	it("drops a mark whose bullet was deleted by hand", () => {
		const result = reconcile(doc({ "01k9aaa": pageLocator(1) }), "# Just a heading\n");

		expect(result.document.clips).toEqual({});
		expect(result.dropped).toEqual(["01k9aaa"]);
		expect(result.changed).toBe(true);
	});

	it("never resurrects: reconciling twice keeps it gone", () => {
		const once = reconcile(doc({ "01k9aaa": pageLocator(1) }), "# Just a heading\n");
		const twice = reconcile(once.document, "# Just a heading\n");

		expect(twice.document.clips).toEqual({});
		expect(twice.changed).toBe(false);
	});

	it("reports a bullet with no locator as unanchored rather than deleting it", () => {
		// A clip whose .reader entry was lost is still perfectly good content. It simply has
		// no mark on the document, and nothing is written back to the note to "fix" it.
		const result = reconcile(doc(), "- > a quote ^hl-01k9ccc\n\t\n");

		expect(result.unanchored).toEqual(["01k9ccc"]);
		expect(result.document.clips).toEqual({});
		expect(result.changed).toBe(false);
	});

	it("handles the mixed case", () => {
		const result = reconcile(
			doc({ "01k9aaa": pageLocator(1), "01k9bbb": pageLocator(2) }),
			"- > kept ^hl-01k9aaa\n\t\n\n- > orphan bullet ^hl-01k9ccc\n\t\n",
		);

		expect(Object.keys(result.document.clips)).toEqual(["01k9aaa"]);
		expect(result.dropped).toEqual(["01k9bbb"]);
		expect(result.unanchored).toEqual(["01k9ccc"]);
	});

	it("drops everything when the note is emptied", () => {
		const result = reconcile(doc({ a: pageLocator(1), b: pageLocator(2) }), "");
		expect(result.document.clips).toEqual({});
		expect(result.dropped).toHaveLength(2);
	});

	it("does not mutate the document it was given", () => {
		const original = doc({ "01k9aaa": pageLocator(1) });
		reconcile(original, "");
		expect(Object.keys(original.clips)).toEqual(["01k9aaa"]);
	});

	it("never adds anything to the note", () => {
		// Reconciliation only ever narrows .reader. The note is not ours to repair.
		const note = "- > q ^hl-01k9aaa\n\tprose\n";
		const result = reconcile(doc(), note);
		expect(result).not.toHaveProperty("noteBody");
		expect(result.document.clips).toEqual({});
	});
});
