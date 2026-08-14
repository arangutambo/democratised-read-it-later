import { describe, expect, it } from "vitest";

import type { Line } from "../../../src/sources/slides/layout";
import { buildSlides, classify, deckTitleOf, detectTitle, outlineOf } from "../../../src/sources/slides/structure";

function lines(...entries: ([string] | [string, number])[]): Line[] {
	return entries.map(([text, size], i) => ({ text, size: size ?? 10, y: 500 - i * 20 }));
}

/** Slide 1 of BINF7001 Week 1, as the layout code actually produces it. */
const REAL_TITLE_SLIDE = lines(
	["BINF7001 Advanced", 30],
	["Genome Informatics", 30],
	["Module 1", 18],
	["Introduction to command-line, high-", 14],
	["throughput data and read mapping", 14],
	["Semester 2, 2026", 12],
	["Course Coordinator", 12],
	["Scott Beatson (scott.beatson@uq.edu.au)", 12],
);

describe("detectTitle", () => {
	it("takes a visibly larger opening line", () => {
		expect(detectTitle(lines(["Course structure", 20], ["some body text", 10]))).toBe("Course structure");
	});

	it("takes the only line on a slide", () => {
		expect(detectTitle(lines(["Summary"]))).toBe("Summary");
	});

	it("takes a short unpunctuated opening line even at uniform size", () => {
		// Plenty of decks set every slide in one size.
		expect(detectTitle(lines(["Teaching team"], ["Scott Beatson"], ["Nick Matigian"]))).toBe("Teaching team");
	});

	it("rejects a bare number, which is a slide number not a heading", () => {
		expect(detectTitle(lines(["3"], ["body text here"]))).toBeUndefined();
	});

	it("rejects an over-long opening line", () => {
		expect(detectTitle(lines(["x".repeat(200)]))).toBeUndefined();
	});

	it("returns nothing for an empty slide", () => {
		expect(detectTitle([])).toBeUndefined();
	});
});

describe("classify", () => {
	it("calls a real lecture title slide a title slide", () => {
		// 167 characters over 8 lines — a character-count rule misses this, which is why the
		// heuristic counts lines instead.
		expect(classify(REAL_TITLE_SLIDE, 1, 19)).toBe("title");
	});

	it("does not call a bulleted first slide a title slide", () => {
		const bulleted = lines(["Housekeeping"], ["• Don't panic"], ["• Follow instructions"]);
		expect(classify(bulleted, 1, 19)).toBe("content");
	});

	it("recognises a section break", () => {
		expect(classify(lines(["Learning objectives", 20]), 4, 30)).toBe("section");
	});

	it("recognises a summary", () => {
		expect(classify(lines(["Key takeaways", 20]), 28, 30)).toBe("summary");
	});

	it("treats a heading-only slide at the end as a summary", () => {
		expect(classify(lines(["Where next", 20]), 30, 30)).toBe("summary");
	});

	it("calls a dense slide content even with a section-sounding heading", () => {
		const dense = lines(["Introduction", 20], ["x".repeat(200)]);
		expect(classify(dense, 2, 30)).toBe("content");
	});

	it("calls an empty slide blank", () => {
		expect(classify([], 5, 30)).toBe("blank");
	});
});

describe("deckTitleOf", () => {
	it("joins leading lines that share the largest size", () => {
		// "BINF7001 Advanced" and "Genome Informatics" are one title typeset over two lines.
		const [slide] = buildSlides([REAL_TITLE_SLIDE]);
		expect(deckTitleOf(slide)).toContain("BINF7001 Advanced Genome Informatics");
	});

	it("returns nothing without a title slide", () => {
		expect(deckTitleOf(undefined)).toBeUndefined();
	});
});

describe("outlineOf", () => {
	it("counts slides by kind and reports the deck title", () => {
		const slides = buildSlides([REAL_TITLE_SLIDE, lines(["Body", 20], ["text"]), lines(["Summary", 20])]);
		const outline = outlineOf(slides);

		expect(outline.counts.title).toBe(1);
		expect(outline.counts.summary).toBe(1);
		expect(outline.title).toContain("BINF7001");
	});
});
