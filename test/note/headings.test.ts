import { describe, expect, it } from "vitest";

import {
	ensureHeadings,
	hasHeading,
	headingFor,
	sectionsForPage,
	type Section,
} from "../../src/note/headings";

/** A textbook's table of contents, as pdf.js reports one. */
const OUTLINE: Section[] = [
	{ title: "1 Vectors", depth: 0, page: 3 },
	{ title: "1.1 Vectors in R2", depth: 1, page: 3 },
	{ title: "1.2 Vectors in Rn", depth: 1, page: 14 },
	{ title: "1.2.2 Dot product", depth: 2, page: 16 },
	{ title: "2 Matrices", depth: 0, page: 31 },
	{ title: "2.1 Basic operations", depth: 1, page: 32 },
];

describe("headingFor", () => {
	it("starts at two hashes, leaving one free for a title of your own", () => {
		expect(headingFor({ title: "1 Vectors", depth: 0, page: 3 })).toBe("## 1 Vectors");
		expect(headingFor({ title: "1.1 Sub", depth: 1, page: 3 })).toBe("### 1.1 Sub");
	});

	it("stops at six, which is as deep as markdown goes", () => {
		expect(headingFor({ title: "deep", depth: 9, page: 1 })).toBe("###### deep");
	});
});

describe("sectionsForPage", () => {
	it("returns the chain a page falls in, outermost first", () => {
		expect(sectionsForPage(OUTLINE, 16).map((s) => s.title)).toEqual([
			"1 Vectors",
			"1.2 Vectors in Rn",
			"1.2.2 Dot product",
		]);
	});

	it("keeps a section running until the next one at its depth", () => {
		// Page 40 is in chapter 2 even though chapter 2's entry names only page 31.
		expect(sectionsForPage(OUTLINE, 40).map((s) => s.title)).toEqual([
			"2 Matrices",
			"2.1 Basic operations",
		]);
	});

	it("drops deeper sections when a shallower one starts", () => {
		// 2 Matrices must not inherit 1.2.2 Dot product from the chapter before it.
		expect(sectionsForPage(OUTLINE, 31).map((s) => s.title)).toEqual(["2 Matrices"]);
	});

	it("is empty before the first section", () => {
		expect(sectionsForPage(OUTLINE, 1)).toEqual([]);
	});

	it("is empty for a document with no outline", () => {
		expect(sectionsForPage([], 12)).toEqual([]);
	});
});

describe("hasHeading", () => {
	it("matches a heading already in the note", () => {
		expect(hasHeading(["## 1 Vectors", "- > a clip"], OUTLINE[0])).toBe(true);
	});

	it("does not match a different depth", () => {
		expect(hasHeading(["### 1 Vectors"], OUTLINE[0])).toBe(false);
	});

	it("does not match prose that merely mentions it", () => {
		expect(hasHeading(["I read 1 Vectors today"], OUTLINE[0])).toBe(false);
	});
});

describe("ensureHeadings", () => {
	/** Place every heading at the end, which is enough to test the mechanics. */
	const atEnd = (lines: readonly string[]) => () => lines.length;

	it("adds a missing heading", () => {
		const { lines } = ensureHeadings([], [OUTLINE[0]], () => 0);
		expect(lines).toEqual(["## 1 Vectors"]);
	});

	it("adds nothing when the heading is already there", () => {
		const before = ["## 1 Vectors", "- > a clip ^hl-aaa"];
		const { lines, added } = ensureHeadings(before, [OUTLINE[0]], atEnd(before));

		expect(lines).toEqual(before);
		expect(added).toBe(0);
	});

	it("adds the whole chain, outermost first", () => {
		const { lines } = ensureHeadings([], [OUTLINE[0], OUTLINE[2]], () => 0);
		expect(lines.filter((l) => l.startsWith("#"))).toEqual(["## 1 Vectors", "### 1.2 Vectors in Rn"]);
	});

	it("puts a blank line above a heading that follows content", () => {
		// Without one, markdown does not treat the line as a heading at all.
		const before = ["- > a clip ^hl-aaa", "\t- "];
		const { lines } = ensureHeadings(before, [OUTLINE[0]], atEnd(before));

		expect(lines[lines.length - 2]).toBe("");
		expect(lines[lines.length - 1]).toBe("## 1 Vectors");
	});

	it("does not open the note with a blank line", () => {
		expect(ensureHeadings([], [OUTLINE[0]], () => 0).lines[0]).toBe("## 1 Vectors");
	});

	it("never edits an existing line", () => {
		const before = ["# My own title", "", "Some prose I wrote."];
		const { lines } = ensureHeadings(before, [OUTLINE[0]], atEnd(before));

		for (const line of before) expect(lines).toContain(line);
	});

	it("does nothing for a document with no sections", () => {
		const before = ["- > a clip ^hl-aaa"];
		expect(ensureHeadings(before, [], atEnd(before)).lines).toEqual(before);
	});
});
