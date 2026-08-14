import { describe, expect, it } from "vitest";

import { PageWindow } from "../../src/reader/render/virtualiser";

/** Workbook 2026.pdf is 315 pages; the biggest real document in this vault. */
const WORKBOOK = 315;

describe("PageWindow", () => {
	it("renders the current page first", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 5 });
		expect(w.update(100).render[0]).toBe(100);
	});

	it("holds the current page and its neighbours", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 3 });
		w.update(100);
		expect(w.held).toEqual([99, 100, 101]);
	});

	it("never exceeds the budget, anywhere in a 315-page document", () => {
		// The whole reason this module exists. A canvas is 10–15 MB; unbounded is gigabytes.
		const w = new PageWindow({ total: WORKBOOK, budget: 5 });
		for (let page = 1; page <= WORKBOOK; page++) {
			w.update(page);
			expect(w.size).toBeLessThanOrEqual(5);
		}
	});

	it("releases exactly what it drops as it moves", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 3 });
		w.update(100);
		const change = w.update(101);

		expect(change.release).toEqual([99]);
		expect(change.render).toEqual([102]);
		expect(w.held).toEqual([100, 101, 102]);
	});

	it("biases the window forwards when reading forwards", () => {
		// Reading on should not stall on a render at every page turn.
		const w = new PageWindow({ total: WORKBOOK, budget: 4 });
		w.update(100);
		w.update(101);

		expect(w.held).toEqual([100, 101, 102, 103]);
	});

	it("biases backwards when paging back", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 4 });
		w.update(100);
		w.update(99);

		expect(w.held).toEqual([97, 98, 99, 100]);
	});

	it("clamps at the start of the document", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 5 });
		w.update(1);

		expect(w.held).toEqual([1, 2, 3, 4, 5]);
		expect(w.held.every((p) => p >= 1)).toBe(true);
	});

	it("clamps at the end of the document", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 5 });
		w.update(WORKBOOK);

		expect(w.held.every((p) => p <= WORKBOOK)).toBe(true);
		expect(w.held).toContain(WORKBOOK);
	});

	it("copes with a document shorter than the budget", () => {
		const w = new PageWindow({ total: 2, budget: 5 });
		w.update(1);
		expect(w.held).toEqual([1, 2]);
	});

	it("copes with a single-page document", () => {
		const w = new PageWindow({ total: 1, budget: 5 });
		expect(w.update(1).render).toEqual([1]);
		expect(w.held).toEqual([1]);
	});

	it("refuses a budget below three, so reading either way never blanks", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 1 });
		w.update(100);
		expect(w.size).toBe(3);
	});

	it("clamps a page number outside the document", () => {
		const w = new PageWindow({ total: 10, budget: 3 });
		w.update(999);
		expect(w.held).toContain(10);
		expect(w.held.every((p) => p <= 10)).toBe(true);

		w.update(-5);
		expect(w.held).toContain(1);
		expect(w.held.every((p) => p >= 1)).toBe(true);
	});

	it("renders nothing again when the page has not changed", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 5 });
		w.update(100);
		const change = w.update(100);

		expect(change.render).toEqual([]);
		expect(change.release).toEqual([]);
	});

	it("releases everything on clear", () => {
		const w = new PageWindow({ total: WORKBOOK, budget: 5 });
		w.update(100);
		const change = w.clear();

		expect(change.release).toHaveLength(5);
		expect(w.size).toBe(0);
	});

	it("holds nothing that was released, jumping across the document", () => {
		// The outline sidebar jumps; the window must not accumulate the pages it passed.
		const w = new PageWindow({ total: WORKBOOK, budget: 5 });
		for (const page of [1, 200, 50, 314, 7]) w.update(page);

		expect(w.size).toBeLessThanOrEqual(5);
		expect(w.held).toContain(7);
		expect(w.held).not.toContain(200);
	});
});
