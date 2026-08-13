import { describe, expect, it } from "vitest";

import type { Line } from "../../../src/sources/slides/layout";
import { buildSections, outlineOf } from "../../../src/sources/document/structure";
import { buildDocumentBody, summarise } from "../../../src/sources/document/note";
import { classifyShape } from "../../../src/sources/pdf/shape";

/** Lines with explicit y positions, so vertical spacing is part of the fixture. */
function page(entries: [text: string, size: number, y: number][]): Line[] {
	return entries.map(([text, size, y]) => ({ text, size, y }));
}

describe("classifyShape", () => {
	it("calls landscape pages slides", () => {
		const verdict = classifyShape({
			sizes: [
				{ width: 960, height: 540 },
				{ width: 960, height: 540 },
			],
			charactersPerPage: 300,
			pageCount: 2,
		});
		expect(verdict.shape).toBe("slides");
	});

	it("calls dense portrait pages a document", () => {
		// Real workshop handouts run 1,800–3,000 characters per portrait page.
		const verdict = classifyShape({
			sizes: [{ width: 595, height: 842 }],
			charactersPerPage: 2600,
			pageCount: 5,
		});
		expect(verdict.shape).toBe("document");
		expect(verdict.reason).toContain("portrait");
	});

	it("treats a sparse portrait PDF as pages, not prose", () => {
		// A printed deck or a cover sheet: per-page notes lose nothing, whereas the document
		// pipeline over near-empty pages yields headings with no content.
		const verdict = classifyShape({
			sizes: [{ width: 595, height: 842 }],
			charactersPerPage: 220,
			pageCount: 4,
		});
		expect(verdict.shape).toBe("slides");
	});

	it("keeps a dense landscape deck as slides", () => {
		const verdict = classifyShape({
			sizes: [{ width: 960, height: 540 }],
			charactersPerPage: 2000,
			pageCount: 10,
		});
		expect(verdict.shape).toBe("slides");
	});

	it("falls back to density when page sizes are unavailable", () => {
		expect(classifyShape({ sizes: [], charactersPerPage: 2000, pageCount: 3 }).shape).toBe("document");
		expect(classifyShape({ sizes: [], charactersPerPage: 200, pageCount: 3 }).shape).toBe("slides");
	});
});

describe("buildSections", () => {
	it("splits on headings set in a larger font", () => {
		const sections = buildSections([
			page([
				["Introduction", 16, 700],
				["Some body text that runs on for a while.", 11, 680],
				["Methods", 16, 640],
				["More body text explaining the method.", 11, 620],
			]),
		]);

		expect(sections.map((s) => s.heading)).toEqual(["Introduction", "Methods"]);
		expect(sections[0].body).toContain("runs on for a while");
	});

	it("records the page a section starts on", () => {
		const sections = buildSections([
			page([
				["One", 16, 700],
				["body", 11, 680],
			]),
			page([
				["Two", 16, 700],
				["body", 11, 680],
			]),
		]);
		expect(sections.map((s) => s.page)).toEqual([1, 2]);
	});

	it("finds headings in a document typeset at a single size", () => {
		// Two of five real workshop handouts do this, and size-based detection found nothing,
		// producing one section holding the whole document.
		const sections = buildSections([
			page([
				["How do I use regex in grep?", 11, 700],
				["A regular expression is a series of characters forming a pattern.", 11, 686],
				["It matches against other strings in the file you give it.", 11, 672],
				["What about sed?", 11, 640],
				["The sed command performs substitution across a stream of text.", 11, 626],
			]),
		]);

		expect(sections.map((s) => s.heading)).toEqual(["How do I use regex in grep?", "What about sed?"]);
	});

	it("does not mistake a paragraph's short last line for a heading", () => {
		// Extracted "lines" are visual lines, so every paragraph ends with a short one. Without
		// requiring space above, this rule produced 35 sections across five real pages.
		const sections = buildSections([
			page([
				["This paragraph runs across two lines and ends", 11, 700],
				["short.", 11, 686],
				["The next paragraph begins immediately afterwards here.", 11, 672],
			]),
		]);

		expect(sections.filter((s) => s.heading)).toHaveLength(0);
	});

	it("does not mistake code or notation for a heading", () => {
		// A regex handout is full of short, well-spaced reference lines.
		const sections = buildSections([
			page([
				["Reference table", 11, 700],
				["A line of ordinary prose that is clearly longer than the heading.", 11, 686],
				["[abc] matches a, b or c", 11, 640],
				["Another line of ordinary prose following the notation entry above.", 11, 626],
				["sed 's/regex/replacement/'", 11, 580],
				["And more ordinary prose text following that shell command line.", 11, 566],
			]),
		]);

		expect(sections.map((s) => s.heading)).toEqual(["Reference table"]);
	});

	it("returns nothing for an empty document", () => {
		expect(buildSections([])).toEqual([]);
	});
});

describe("buildDocumentBody", () => {
	const sections = buildSections([
		page([
			["Introduction", 16, 700],
			["Body text here for the section.", 11, 680],
		]),
	]);

	it("links to the page rather than embedding it", () => {
		// A handout's page is not a unit of meaning; twenty page images through a worksheet
		// would bury the prose.
		const body = buildDocumentBody(sections, { documentPath: "Sources/_decks/w3.pdf" });
		expect(body).toContain("#page=1)");
		expect(body).not.toContain("![[");
	});

	it("puts each section's text in its own managed region", () => {
		const body = buildDocumentBody(sections, { documentPath: "d.pdf" });
		expect(body).toContain("%% reader:begin section-1 hash=");
	});

	it("renders headings at a depth reflecting their size", () => {
		const body = buildDocumentBody(sections, { documentPath: "d.pdf" });
		expect(body).toContain("## Introduction");
	});

	it("leaves room to write between sections", () => {
		const two = buildSections([
			page([
				["Introduction", 16, 700],
				["Body text here for the section.", 11, 680],
				["Methods", 16, 640],
				["More body text explaining the method.", 11, 620],
			]),
		]);
		const body = buildDocumentBody(two, { documentPath: "d.pdf" });

		// A blank run between the end of one section and the next heading is where the
		// reader writes — the entire point of the scaffold.
		expect(body).toMatch(/#page=1\)\n\n\n## Methods/);
	});
});

describe("outlineOf and summarise", () => {
	it("reports the first heading as the document title", () => {
		const sections = buildSections([
			page([
				["Week 3: Pattern matching", 16, 700],
				["body text follows here", 11, 680],
			]),
		]);
		expect(outlineOf(sections).title).toBe("Week 3: Pattern matching");
		expect(summarise(sections).headings).toBe(1);
	});
});
