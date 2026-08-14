import { describe, expect, it } from "vitest";

import {
	boxBetween,
	planRegionRender,
	toNormalised,
	toScreen,
	WHOLE_SURFACE,
} from "../../src/reader/gesture/region";

/** A4 portrait in PDF points, which is what a problem sheet actually is. */
const A4 = { width: 595, height: 842 };

describe("boxBetween", () => {
	it("handles a drag down and to the right", () => {
		expect(boxBetween({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({
			x: 10,
			y: 20,
			width: 100,
			height: 200,
		});
	});

	it("handles a drag up and to the left", () => {
		// Half of all drags. Assuming the first point is the top-left gives a negative width.
		expect(boxBetween({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual({
			x: 10,
			y: 20,
			width: 100,
			height: 200,
		});
	});

	it("handles a drag up and to the right", () => {
		expect(boxBetween({ x: 10, y: 220 }, { x: 110, y: 20 })).toEqual({
			x: 10,
			y: 20,
			width: 100,
			height: 200,
		});
	});

	it("gives a zero box for a click", () => {
		expect(boxBetween({ x: 50, y: 50 }, { x: 50, y: 50 })).toEqual({
			x: 50,
			y: 50,
			width: 0,
			height: 0,
		});
	});
});

describe("normalised round trip", () => {
	it("survives screen → normalised → screen", () => {
		const box = { x: 100, y: 200, width: 300, height: 150 };
		const back = toScreen(toNormalised(box, 800, 1000), 800, 1000);
		expect(back).toEqual(box);
	});

	it("is independent of zoom, which is the point of storing it normalised", () => {
		// The same region drawn at two zoom levels must store identically, or reopening the
		// document at a different size moves every mark.
		const atOneX = toNormalised({ x: 100, y: 200, width: 300, height: 150 }, 800, 1000);
		const atTwoX = toNormalised({ x: 200, y: 400, width: 600, height: 300 }, 1600, 2000);
		expect(atOneX).toEqual(atTwoX);
	});

	it("does not divide by zero on a page that has not been laid out yet", () => {
		expect(toNormalised({ x: 1, y: 1, width: 1, height: 1 }, 0, 0)).toEqual([0, 0, 0, 0]);
	});
});

describe("planRegionRender", () => {
	it("scales by DPI over 72, because a PDF point is 1/72 inch", () => {
		expect(planRegionRender(WHOLE_SURFACE, A4, 150).scale).toBeCloseTo(150 / 72, 10);
	});

	it("renders a full A4 page at 150 DPI at roughly print size", () => {
		const plan = planRegionRender(WHOLE_SURFACE, A4, 150);

		// 595pt ≈ 8.27in × 150dpi ≈ 1240px. This is the number that decides whether small type
		// in a dense slide is still readable when you zoom into the clip.
		expect(plan.width).toBe(1240);
		expect(plan.height).toBe(1754);
	});

	it("crops the requested region out of the scaled page", () => {
		const plan = planRegionRender([0.25, 0.5, 0.5, 0.25], A4, 150);

		expect(plan.crop.x).toBeCloseTo(1240.1 * 0.25, 0);
		expect(plan.width).toBe(Math.round((595 * 150) / 72 / 2));
		expect(plan.height).toBe(Math.round((842 * 150) / 72 / 4));
	});

	it("never produces a zero-dimension image", () => {
		// A canvas of zero width throws rather than producing an empty PNG.
		const plan = planRegionRender([0.5, 0.5, 0.00001, 0.00001], A4, 150);
		expect(plan.width).toBeGreaterThanOrEqual(1);
		expect(plan.height).toBeGreaterThanOrEqual(1);
	});

	it("caps an enormous page rather than allocating a dead tab", () => {
		// A0 conference poster: 2384 × 3370 points. At 150 DPI that is 4967 × 7021 px, which is
		// 35 megapixels and about 140 MB of canvas at 4 bytes a pixel.
		const a0 = { width: 2384, height: 3370 };
		const uncapped = planRegionRender(WHOLE_SURFACE, a0, 150, Number.MAX_SAFE_INTEGER);
		expect(uncapped.width * uncapped.height).toBeGreaterThan(34_000_000);

		const plan = planRegionRender(WHOLE_SURFACE, a0, 150);

		expect(plan.scale).toBeLessThan(150 / 72);
		expect(plan.width * plan.height).toBeLessThanOrEqual(16_000_000);
	});

	it("leaves every ordinary page and DPI uncapped", () => {
		// The guard must never bite on real coursework, or clips quietly lose resolution.
		for (const dpi of [150, 200, 300]) {
			expect(planRegionRender(WHOLE_SURFACE, A4, dpi).scale).toBeCloseTo(dpi / 72, 10);
		}
		// A3 landscape, the biggest thing a lecture deck realistically is.
		expect(planRegionRender(WHOLE_SURFACE, { width: 1191, height: 842 }, 200).scale).toBeCloseTo(200 / 72, 10);
	});

	it("refuses a nonsensical DPI rather than producing a zero scale", () => {
		expect(planRegionRender(WHOLE_SURFACE, A4, 0).scale).toBeGreaterThan(0);
		expect(planRegionRender(WHOLE_SURFACE, A4, -50).scale).toBeGreaterThan(0);
	});

	it("treats key 3 as the unit rect", () => {
		const whole = planRegionRender(WHOLE_SURFACE, A4, 150);
		expect(whole.crop).toEqual({ x: 0, y: 0, width: whole.crop.width, height: whole.crop.height });
	});
});
