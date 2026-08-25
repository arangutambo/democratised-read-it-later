/**
 * What may be dropped on the shelf, and where it lands.
 *
 * These are the parts of drag-and-drop that can be wrong without anyone noticing: a file
 * silently overwriting one you already annotated, or a name the vault quietly refuses.
 */

import { describe, expect, it } from "vitest";

import { freePathFor, safeName, splitName, triage } from "../../src/library/drop";

describe("splitName", () => {
	it("splits at the last dot, so a dotted title keeps its name", () => {
		expect(splitName("Ch. 3 Notes.pdf")).toEqual({ base: "Ch. 3 Notes", extension: "pdf" });
	});

	it("treats a leading dot as a hidden file rather than an extension", () => {
		expect(splitName(".gitignore")).toEqual({ base: ".gitignore", extension: "" });
	});

	it("copes with no extension at all", () => {
		expect(splitName("README")).toEqual({ base: "README", extension: "" });
	});
});

describe("triage", () => {
	it("keeps what Reader can open and names what it cannot", () => {
		const { accepted, rejected } = triage(["a.pdf", "b.epub", "c.html", "d.docx", "e.png"]);

		expect(accepted.map((c) => c.name)).toEqual(["a.pdf", "b.epub", "c.html"]);
		expect(accepted.map((c) => c.kind)).toEqual(["pdf", "epub", "html"]);
		// Named, not swallowed: dropping five and getting three needs an explanation.
		expect(rejected).toEqual(["d.docx", "e.png"]);
	});

	it("does not care how the extension was capitalised", () => {
		expect(triage(["Slides.PDF"]).accepted).toHaveLength(1);
	});

	it("accepts .htm as well as .html, which is what a saved page often is", () => {
		expect(triage(["page.htm"]).accepted[0].kind).toBe("html");
	});
});

describe("safeName", () => {
	it("removes what a vault path will not take", () => {
		expect(safeName('a/b:c*d?e"f<g>h|i#j^k[l]m')).toBe("a b c d e f g h i j k l m");
	});

	it("never returns an empty name", () => {
		expect(safeName("///")).toBe("Document");
	});
});

describe("freePathFor", () => {
	it("uses the dropped name when nothing is in the way", () => {
		expect(freePathFor("Sources/_decks", "Lecture 4.pdf", () => false)).toBe(
			"Sources/_decks/Lecture 4.pdf",
		);
	});

	/**
	 * The important one. Dropping the same file twice makes a second document — the first may
	 * already carry highlights, and silently replacing it would delete work.
	 */
	it("steps aside rather than overwriting an existing document", () => {
		const existing = new Set(["Sources/_decks/Lecture 4.pdf", "Sources/_decks/Lecture 4 2.pdf"]);
		expect(freePathFor("Sources/_decks", "Lecture 4.pdf", (p) => existing.has(p))).toBe(
			"Sources/_decks/Lecture 4 3.pdf",
		);
	});

	it("keeps the extension when it sidesteps", () => {
		const taken = new Set(["docs/a.epub"]);
		expect(freePathFor("docs", "a.epub", (p) => taken.has(p))).toBe("docs/a 2.epub");
	});

	it("writes to the vault root when no folder is configured", () => {
		expect(freePathFor("", "a.pdf", () => false)).toBe("a.pdf");
	});
});
