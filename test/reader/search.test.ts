import { describe, expect, it } from "vitest";

import { findInPage, normalise, searchDocument } from "../../src/reader/search";

/** Text as a PDF layer actually produces it: broken lines, inconsistent spacing. */
const PAGE = "The dot   product between vectors\nv, w is defined as the sum. The DOT PRODUCT is commutative.";

describe("normalise", () => {
	it("collapses the whitespace a line break leaves behind", () => {
		expect(normalise("dot\n  product")).toBe("dot product");
	});

	it("folds case", () => {
		expect(normalise("DOT Product")).toBe("dot product");
	});
});

describe("findInPage", () => {
	it("finds a phrase broken across a line", () => {
		// The whole reason matching is normalised: the layer contains the break, you did not.
		expect(findInPage("the dot\nproduct", 3, "dot product")).toHaveLength(1);
	});

	it("ignores case", () => {
		expect(findInPage(PAGE, 3, "DOT PRODUCT")).toHaveLength(2);
	});

	it("reports the page each hit is on", () => {
		expect(findInPage(PAGE, 12, "dot product").every((h) => h.page === 12)).toBe(true);
	});

	it("gives a snippet with surrounding context", () => {
		const [hit] = findInPage(PAGE, 3, "between vectors");
		expect(hit.snippet).toContain("between vectors");
		expect(hit.snippet.length).toBeGreaterThan("between vectors".length);
	});

	it("marks a truncated snippet with an ellipsis", () => {
		const long = `${"padding ".repeat(20)}needle${" padding".repeat(20)}`;
		expect(findInPage(long, 1, "needle")[0].snippet).toMatch(/^….*…$/);
	});

	it("does not mark a snippet that reaches the edges", () => {
		expect(findInPage("just needle here", 1, "needle")[0].snippet).not.toContain("…");
	});

	it("does not overlap matches", () => {
		expect(findInPage("aaaa", 1, "aa")).toHaveLength(2);
	});

	it("returns nothing for an empty query", () => {
		expect(findInPage(PAGE, 1, "   ")).toEqual([]);
	});

	it("caps a pathological query rather than returning thousands", () => {
		expect(findInPage("a".repeat(5000), 1, "a").length).toBeLessThanOrEqual(50);
	});
});

describe("searchDocument", () => {
	const pages: Record<number, string> = {
		1: "nothing here",
		2: "the dot product appears",
		3: "and the dot product again",
	};
	const textOf = async (page: number) => pages[page] ?? "";

	it("searches every page", async () => {
		const hits = await searchDocument("dot product", 3, textOf);
		expect(hits.map((h) => h.page)).toEqual([2, 3]);
	});

	it("reports progress as it goes", async () => {
		// A 315-page workbook is a worker round trip per page; results have to appear early.
		const seen: number[] = [];
		await searchDocument("dot", 3, textOf, { onProgress: (p) => seen.push(p.done) });

		expect(seen).toEqual([1, 2, 3]);
	});

	it("stops when the search is abandoned", async () => {
		// Typing another character must abandon the previous search rather than race it.
		const controller = new AbortController();
		const hits = await searchDocument(
			"dot",
			3,
			async (page) => {
				if (page === 2) controller.abort();
				return pages[page] ?? "";
			},
			{ signal: controller.signal },
		);

		expect(hits.length).toBeLessThan(2);
	});

	it("survives a page that will not extract", async () => {
		const hits = await searchDocument("dot product", 3, async (page) => {
			if (page === 2) throw new Error("broken page");
			return pages[page] ?? "";
		});

		expect(hits.map((h) => h.page)).toEqual([3]);
	});

	it("returns nothing for an empty query without touching a page", async () => {
		let touched = 0;
		const hits = await searchDocument("  ", 3, async () => {
			touched++;
			return "";
		});

		expect(hits).toEqual([]);
		expect(touched).toBe(0);
	});
});
