import { describe, expect, it } from "vitest";

import { hasCitekey, hasFrontmatter, withPaperFrontmatter } from "../../src/note/frontmatter";
import type { Csl } from "../../src/core/types";

const PAPER: Csl = {
	type: "article-journal",
	title: "The magical number 4 in short-term memory",
	author: [{ family: "Cowan", given: "Nelson" }],
	issued: { "date-parts": [[2001]] },
	"container-title": "Behavioral and Brain Sciences",
	DOI: "10.1017/S0140525X01003922",
};

describe("hasFrontmatter", () => {
	it("recognises a block at the very top", () => {
		expect(hasFrontmatter("---\ntitle: x\n---\n")).toBe(true);
	});

	it("does not count three dashes further down as frontmatter", () => {
		// A horizontal rule mid-note is not a properties block.
		expect(hasFrontmatter("# Notes\n\n---\n\nmore")).toBe(false);
	});
});

describe("hasCitekey", () => {
	it("finds one in the block", () => {
		expect(hasCitekey("---\ncitekey: cowan2001\n---\n")).toBe(true);
	});

	it("does not count an empty value", () => {
		expect(hasCitekey("---\ncitekey:\n---\n")).toBe(false);
	});

	it("does not look outside the block", () => {
		expect(hasCitekey("---\ntitle: x\n---\n\ncitekey: not-really\n")).toBe(false);
	});
});

describe("withPaperFrontmatter", () => {
	it("adds a citekey and the CSL fields that are present", () => {
		const out = withPaperFrontmatter("", { citekey: "cowan2001magical", csl: PAPER });

		expect(out.startsWith("---\ncitekey: cowan2001magical\ncsl:\n")).toBe(true);
		expect(out).toContain("  type: article-journal");
		expect(out).toContain("  DOI: 10.1017/S0140525X01003922");
		expect(out).toContain("  year: 2001");
	});

	it("lists authors as names, not as objects", () => {
		const out = withPaperFrontmatter("", { citekey: "k", csl: PAPER });
		expect(out).toContain("  author:\n    - Nelson Cowan");
	});

	it("omits fields the item does not have", () => {
		const out = withPaperFrontmatter("", { citekey: "k", csl: { type: "book" } });

		expect(out).not.toContain("DOI");
		expect(out).not.toContain("year");
		expect(out).not.toContain("author");
	});

	it("quotes a title containing a colon, which would otherwise break the YAML", () => {
		const out = withPaperFrontmatter("", {
			citekey: "k",
			csl: { type: "book", title: "Statistics: a primer" },
		});

		expect(out).toContain('  title: "Statistics: a primer"');
	});

	it("keeps the note's existing body underneath", () => {
		const body = "- > a clip ^hl-aaa\n\t- \n";
		expect(withPaperFrontmatter(body, { citekey: "k", csl: PAPER }).endsWith(body)).toBe(true);
	});

	it("leaves a note that already has frontmatter completely alone", () => {
		/*
		 * The citekey is generated once and stored forever. Better BibTeX's history is the
		 * warning: unstable keys silently break every draft that cites them, and you find out
		 * at submission. Merging into someone else's YAML is also how a plugin corrupts a file.
		 */
		const body = "---\ntags: [paper]\n---\n\n# My notes\n";
		expect(withPaperFrontmatter(body, { citekey: "different", csl: PAPER })).toBe(body);
	});

	it("produces a block Obsidian will parse", () => {
		const out = withPaperFrontmatter("body\n", { citekey: "k", csl: PAPER });
		const lines = out.split("\n");

		expect(lines[0]).toBe("---");
		expect(lines.indexOf("---", 1)).toBeGreaterThan(1);
		expect(out.split("---")).toHaveLength(3);
	});
});
