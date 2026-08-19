import { describe, expect, it } from "vitest";

import { columnOf, detectColumns, readingOrder, runBetween, spanAt } from "../../src/reader/gesture/columns";
import type { TextSpan } from "../../src/reader/surface/pdf";

function span(text: string, left: number, top: number, width = 0.3, height = 0.02): TextSpan {
	return { text, left, top, width, height };
}

/**
 * A two-column textbook page, as the DNA-sequencing PDFs actually are: body text on the left,
 * a figure caption on the right, both at the same heights.
 */
function twoColumnPage(): TextSpan[] {
	const out: TextSpan[] = [];
	for (let i = 0; i < 6; i++) {
		out.push(span(`body ${i}`, 0.1, 0.4 + i * 0.03, 0.32));
		out.push(span(`caption ${i}`, 0.58, 0.4 + i * 0.03, 0.3));
	}
	return out;
}

describe("detectColumns", () => {
	it("finds the gutter on a two-column page", () => {
		const boundaries = detectColumns(twoColumnPage());

		expect(boundaries).toHaveLength(1);
		expect(boundaries[0]).toBeGreaterThan(0.42);
		expect(boundaries[0]).toBeLessThan(0.58);
	});

	it("finds no gutter on a single column", () => {
		const single = Array.from({ length: 12 }, (_, i) => span(`line ${i}`, 0.1, 0.2 + i * 0.03, 0.8));
		expect(detectColumns(single)).toEqual([]);
	});

	it("does not mistake word spacing for a gutter", () => {
		// Runs with ordinary gaps between them are one column, not eight.
		const words = Array.from({ length: 12 }, (_, i) => span("word", 0.1 + (i % 4) * 0.2, 0.2 + Math.floor(i / 4) * 0.03, 0.18));
		expect(detectColumns(words)).toEqual([]);
	});

	it("says nothing about a page with almost no text", () => {
		expect(detectColumns([span("a", 0.1, 0.1)])).toEqual([]);
	});
});

describe("columnOf", () => {
	it("places a span by its centre", () => {
		expect(columnOf(span("left", 0.1, 0.4, 0.3), [0.5])).toBe(0);
		expect(columnOf(span("right", 0.58, 0.4, 0.3), [0.5])).toBe(1);
	});
});

describe("readingOrder", () => {
	it("reads a column down before starting the next", () => {
		/*
		 * Sorting by y alone interleaves the two, which is why selecting a sentence of body text
		 * used to pull in the figure caption sitting beside it.
		 */
		const order = readingOrder(twoColumnPage()).map((s) => s.text);

		expect(order.slice(0, 6)).toEqual(["body 0", "body 1", "body 2", "body 3", "body 4", "body 5"]);
		expect(order.slice(6)).toEqual([
			"caption 0", "caption 1", "caption 2", "caption 3", "caption 4", "caption 5",
		]);
	});

	it("still reads a single column top to bottom", () => {
		const single = [span("second", 0.1, 0.5, 0.8), span("first", 0.1, 0.2, 0.8)];
		expect(readingOrder(single).map((s) => s.text)).toEqual(["first", "second"]);
	});

	it("reads left to right within a line", () => {
		const line = [span("b", 0.5, 0.2, 0.2), span("a", 0.1, 0.2, 0.2)];
		expect(readingOrder(line).map((s) => s.text)).toEqual(["a", "b"]);
	});
});

describe("spanAt", () => {
	it("finds the span under a point", () => {
		expect(spanAt(twoColumnPage(), { x: 0.15, y: 0.41 })?.text).toBe("body 0");
	});

	it("finds the nearest when the point is in whitespace", () => {
		expect(spanAt(twoColumnPage(), { x: 0.5, y: 0.41 })).toBeDefined();
	});

	it("is undefined with nothing to find", () => {
		expect(spanAt([], { x: 0.5, y: 0.5 })).toBeUndefined();
	});
});

describe("runBetween", () => {
	it("takes only what lies between, in reading order", () => {
		// The bug: dragging over three lines of body text also marked the caption beside them.
		const run = runBetween(twoColumnPage(), { x: 0.15, y: 0.41 }, { x: 0.15, y: 0.47 });

		expect(run.map((s) => s.text)).toEqual(["body 0", "body 1", "body 2"]);
		expect(run.some((s) => s.text.startsWith("caption"))).toBe(false);
	});

	it("crosses into the next column when the drag really does", () => {
		const run = runBetween(twoColumnPage(), { x: 0.15, y: 0.52 }, { x: 0.6, y: 0.41 });

		expect(run.map((s) => s.text)).toContain("body 5");
		expect(run.map((s) => s.text)).toContain("caption 0");
	});

	it("copes with the drag going backwards", () => {
		const forward = runBetween(twoColumnPage(), { x: 0.15, y: 0.41 }, { x: 0.15, y: 0.47 });
		const back = runBetween(twoColumnPage(), { x: 0.15, y: 0.47 }, { x: 0.15, y: 0.41 });

		expect(back).toEqual(forward);
	});

	it("is empty with no spans", () => {
		expect(runBetween([], { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([]);
	});
});

describe("reading order as the text layer's DOM order", () => {
	it("puts a whole column before the next one starts", () => {
		/*
		 * The reason this matters is not tidiness. A browser selection follows DOM order, and
		 * the text layer's spans are absolutely positioned — so their order is invisible until
		 * you drag across them. With pdf.js's own order the browser painted its selection over
		 * every span lying between the two ends in the markup, which on a two-column page meant
		 * fragments lit up across the whole thing.
		 */
		const order = readingOrder(twoColumnPage());
		const firstCaption = order.findIndex((s) => s.text.startsWith("caption"));
		const lastBody = order.map((s) => s.text.startsWith("body")).lastIndexOf(true);

		expect(lastBody).toBeLessThan(firstCaption);
	});

	it("is stable, so the same page always lays out the same way", () => {
		const once = readingOrder(twoColumnPage()).map((s) => s.text);
		const twice = readingOrder(twoColumnPage()).map((s) => s.text);
		expect(once).toEqual(twice);
	});

	it("keeps every span", () => {
		// Reordering must never drop one; a missing span is a hole in the selectable text.
		const page = twoColumnPage();
		expect(readingOrder(page)).toHaveLength(page.length);
	});
});
