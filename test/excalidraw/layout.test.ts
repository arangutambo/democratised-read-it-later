import { describe, expect, it } from "vitest";

import { bottomOf, stack } from "../../src/excalidraw/layout";

const A4 = { width: 800, height: 1130 };

describe("stack", () => {
	it("puts clips in a single column", () => {
		const placed = stack([A4, A4, A4], { startY: 0 });
		expect(placed.map((p) => p.x)).toEqual([0, 0, 0]);
		expect(placed.map((p) => p.y)).toEqual([...placed.map((p) => p.y)].sort((a, b) => a - b));
	});

	it("leaves working room under each clip", () => {
		// The whole point: a question, then the space to solve it beneath.
		const [first, second] = stack([A4, A4], { startY: 0 });
		const gapBetween = second.y - (first.y + first.height);

		expect(gapBetween).toBeGreaterThan(A4.height * 0.5);
	});

	it("scales the working room to the clip, with a floor", () => {
		// A whole exam page needs more room under it than a one-line definition, but even a
		// tiny clip needs somewhere to write.
		const [big] = stack([{ width: 800, height: 1200 }], { startY: 0 });
		const [small] = stack([{ width: 200, height: 40 }], { startY: 0 });

		expect(big.frame.height - big.height).toBeGreaterThan(small.frame.height - small.height);
		expect(small.frame.height - small.height).toBeGreaterThanOrEqual(200);
	});

	it("frames each clip with padding around it", () => {
		const [only] = stack([A4], { startY: 0, padding: 20 });

		expect(only.frame.x).toBe(only.x - 20);
		expect(only.frame.y).toBe(only.y - 20);
		expect(only.frame.width).toBe(only.width + 40);
	});

	it("starts where it is told, so a second send lands below existing work", () => {
		const [only] = stack([A4], { startY: 5000 });
		expect(only.y).toBe(5000);
	});

	it("scales an oversized clip down rather than letting it dwarf the others", () => {
		const [wide] = stack([{ width: 4000, height: 2000 }], { startY: 0, maxWidth: 1200 });

		expect(wide.width).toBe(1200);
		// Proportionally, not cropped.
		expect(wide.height).toBe(600);
	});

	it("leaves a clip narrower than the cap alone", () => {
		const [only] = stack([A4], { startY: 0, maxWidth: 1200 });
		expect(only.width).toBe(800);
	});

	it("never produces a zero dimension", () => {
		const [tiny] = stack([{ width: 0, height: 0 }], { startY: 0 });
		expect(tiny.width).toBeGreaterThanOrEqual(1);
		expect(tiny.height).toBeGreaterThanOrEqual(1);
	});

	it("frames never overlap", () => {
		// Overlapping frames in Excalidraw capture each other's contents.
		const placed = stack([A4, A4, A4], { startY: 0 });
		for (let i = 1; i < placed.length; i++) {
			const previous = placed[i - 1].frame;
			expect(placed[i].frame.y).toBeGreaterThan(previous.y + previous.height);
		}
	});

	it("handles nothing", () => {
		expect(stack([], { startY: 0 })).toEqual([]);
	});
});

describe("bottomOf", () => {
	it("finds the lowest point of existing work", () => {
		expect(bottomOf([{ y: 0, height: 100 }, { y: 500, height: 200 }])).toBe(700);
	});

	it("is zero for an empty drawing", () => {
		expect(bottomOf([])).toBe(0);
	});

	it("copes with elements missing a position or size", () => {
		// Excalidraw elements are a union; not all of them carry both.
		expect(bottomOf([{}, { y: 300 }, { height: 50 }])).toBe(300);
	});

	it("ignores negative space above the origin", () => {
		expect(bottomOf([{ y: -900, height: 100 }])).toBe(0);
	});
});
