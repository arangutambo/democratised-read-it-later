import { describe, expect, it, vi } from "vitest";

import { applyResolutions, resolveAll, AbortError } from "../../src/anchor/scheduler";
import type { Highlight } from "../../src/core/types";

const DOC = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";

function highlight(id: string, exact: string, overrides: Partial<Highlight> = {}): Highlight {
	const start = DOC.indexOf(exact);
	return {
		id,
		sourceId: "S",
		text: exact,
		created: "2024-01-01T00:00:00.000Z",
		state: "active",
		anchors: {
			quote: {
				exact,
				prefix: start > 0 ? DOC.slice(Math.max(0, start - 12), start) : "",
				suffix: start >= 0 ? DOC.slice(start + exact.length, start + exact.length + 12) : "",
			},
		},
		...overrides,
	};
}

describe("resolveAll", () => {
	it("resolves every highlight and summarises by strategy", async () => {
		const result = await resolveAll(DOC, [
			highlight("a", "bravo"),
			highlight("b", "delta echo"),
			highlight("c", "kilo lima"),
		]);

		expect(result.resolved).toBe(3);
		expect(result.orphaned).toBe(0);
		expect(result.byStrategy.exact).toBe(3);
		expect(result.resolutions.size).toBe(3);
	});

	it("counts orphans without throwing", async () => {
		const result = await resolveAll(DOC, [
			highlight("a", "bravo"),
			highlight("gone", "text that is nowhere in this document at all"),
		]);

		expect(result.resolved).toBe(1);
		expect(result.orphaned).toBe(1);
		expect(result.resolutions.get("gone")?.ok).toBe(false);
	});

	it("yields between chunks so the UI can paint", async () => {
		// PLAN.md §6: fuzzy-matching a long document on the main thread freezes Obsidian.
		const many = Array.from({ length: 12 }, (_, i) => highlight(`h${i}`, "bravo"));
		const progress: number[] = [];

		await resolveAll(DOC, many, { chunkSize: 5, onProgress: (done) => progress.push(done) });

		expect(progress).toEqual([5, 10, 12]);
	});

	it("stops promptly when aborted", async () => {
		const controller = new AbortController();
		const many = Array.from({ length: 200 }, (_, i) => highlight(`h${i}`, "bravo"));

		const onProgress = vi.fn((done: number) => {
			if (done >= 10) controller.abort();
		});

		await expect(
			resolveAll(DOC, many, { chunkSize: 5, signal: controller.signal, onProgress }),
		).rejects.toBeInstanceOf(AbortError);
	});

	it("does not start at all when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			resolveAll(DOC, [highlight("a", "bravo")], { signal: controller.signal }),
		).rejects.toBeInstanceOf(AbortError);
	});

	it("handles an empty set", async () => {
		const result = await resolveAll(DOC, []);
		expect(result).toMatchObject({ resolved: 0, orphaned: 0 });
	});
});

describe("applyResolutions", () => {
	it("records offsets for resolved highlights", async () => {
		const highlights = [highlight("a", "charlie")];
		const { resolutions } = await resolveAll(DOC, highlights);

		const [updated] = applyResolutions(highlights, resolutions);

		expect(updated.state).toBe("active");
		expect(updated.anchors.offset).toEqual({ start: DOC.indexOf("charlie"), end: DOC.indexOf("charlie") + 7 });
	});

	it("marks failures orphaned while keeping their text and anchors", async () => {
		// Nothing is deleted: an orphan may resolve tomorrow when the source is re-extracted,
		// and the user may want to re-attach it by hand meanwhile.
		const highlights = [highlight("gone", "absolutely not present anywhere here")];
		const { resolutions } = await resolveAll(DOC, highlights);

		const [updated] = applyResolutions(highlights, resolutions);

		expect(updated.state).toBe("orphaned");
		expect(updated.text).toBe("absolutely not present anywhere here");
		expect(updated.anchors.quote.exact).toBe("absolutely not present anywhere here");
	});

	it("leaves highlights that were not part of the run untouched", () => {
		const highlights = [highlight("a", "bravo")];
		expect(applyResolutions(highlights, new Map())).toEqual(highlights);
	});
});
