import { describe, expect, it } from "vitest";

import { quoteSelectorFor, selectionBox } from "../../src/reader/gesture/selection";

/** Minimal stand-in for a DOMRect; only the six fields the code reads. */
function rect(left: number, top: number, right: number, bottom: number): DOMRect {
	return { left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect;
}

function rangeWith(rects: DOMRect[]): Range {
	return { getClientRects: () => rects } as unknown as Range;
}

describe("selectionBox", () => {
	it("returns the box of a single-line selection", () => {
		const box = selectionBox(rangeWith([rect(120, 210, 320, 230)]), rect(100, 200, 900, 800));
		expect(box).toEqual({ x: 20, y: 10, width: 200, height: 20 });
	});

	it("unions a selection that wraps across two lines", () => {
		/*
		 * The reason this is not range.getBoundingClientRect(): a selection running from the
		 * middle of one line to the middle of the next has a bounding box spanning the full
		 * page width. The union of the individual rects starts and ends where the text does.
		 */
		const box = selectionBox(
			rangeWith([rect(300, 210, 500, 230), rect(120, 240, 260, 260)]),
			rect(100, 200, 900, 800),
		);

		expect(box).toEqual({ x: 20, y: 10, width: 380, height: 50 });
	});

	it("ignores zero-area rects, which browsers emit at line boundaries", () => {
		const box = selectionBox(
			rangeWith([rect(300, 210, 300, 230), rect(120, 210, 260, 230)]),
			rect(100, 200, 900, 800),
		);

		expect(box).toEqual({ x: 20, y: 10, width: 140, height: 20 });
	});

	it("returns nothing for a selection with no rects", () => {
		expect(selectionBox(rangeWith([]), rect(0, 0, 100, 100))).toBeUndefined();
	});
});

describe("quoteSelectorFor", () => {
	const page =
		"Gibbs sampling is stochastic. However, it converges to a local optimum, not a " +
		"global one. However, multiple restarts help.";

	it("captures context either side of the quote", () => {
		const selector = quoteSelectorFor(page, "converges to a local optimum");

		expect(selector.exact).toBe("converges to a local optimum");
		expect(selector.prefix.endsWith("it ")).toBe(true);
		expect(selector.suffix.startsWith(", not a global one")).toBe(true);
	});

	it("is what distinguishes two occurrences of the same word", () => {
		// "However" appears twice on this page; exact alone cannot place either one.
		const first = quoteSelectorFor(page, "However", page.indexOf("However"));
		const second = quoteSelectorFor(page, "However", page.lastIndexOf("However"));

		expect(first.prefix).not.toBe(second.prefix);
		expect(first.suffix).not.toBe(second.suffix);
	});

	it("takes the caller's position hint over a naive search", () => {
		const selector = quoteSelectorFor(page, "However", page.lastIndexOf("However"));
		expect(selector.suffix).toContain("multiple restarts");
	});

	it("degrades to empty context when the text is not on the page", () => {
		// A text layer can disagree with the selection when a glyph has no mapping. An empty
		// context still anchors on exact; refusing the clip would lose the words entirely.
		const selector = quoteSelectorFor(page, "not present anywhere");
		expect(selector).toEqual({ exact: "not present anywhere", prefix: "", suffix: "" });
	});

	it("clamps context at the start and end of the page", () => {
		const short = "Short page.";
		expect(quoteSelectorFor(short, "Short")).toEqual({
			exact: "Short",
			prefix: "",
			suffix: " page.",
		});
	});
});
