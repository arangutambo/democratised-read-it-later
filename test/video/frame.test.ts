import { describe, expect, it } from "vitest";

import { captureFrame, FrameCaptureError, rectOf, type CaptureDeps } from "../../src/video/frame";

function bounds(o: Partial<DOMRect>): DOMRect {
	const left = o.left ?? 0;
	const top = o.top ?? 0;
	const width = o.width ?? 640;
	const height = o.height ?? 360;

	return {
		left, top, width, height,
		right: o.right ?? left + width,
		bottom: o.bottom ?? top + height,
		x: left, y: top, toJSON: () => ({}),
	};
}

function deps(png = new Uint8Array([1, 2, 3])): CaptureDeps & { asked: unknown[] } {
	const asked: unknown[] = [];
	return {
		asked,
		pixelRatio: 2,
		webContents: () => ({
			capturePage: async (rect) => {
				asked.push(rect);
				return { toPNG: () => png };
			},
		}),
	};
}

describe("rectOf", () => {
	it("rounds to whole pixels", () => {
		// capturePage takes integers and misbehaves on fractional ones, and a player at a
		// fractional offset is normal the moment a pane has been resized.
		expect(rectOf(bounds({ left: 10.4, top: 20.6, width: 100.2, height: 50.7 }))).toEqual({
			x: 10,
			y: 21,
			width: 101,
			height: 50,
		});
	});

	it("never asks for a zero-sized region", () => {
		const rect = rectOf(bounds({ left: 5, top: 5, width: 0, height: 0, right: 5, bottom: 5 }));
		expect(rect.width).toBeGreaterThan(0);
		expect(rect.height).toBeGreaterThan(0);
	});
});

describe("captureFrame", () => {
	it("captures the region the player occupies", async () => {
		const d = deps();
		const png = await captureFrame(bounds({ left: 0, top: 40, width: 640, height: 360 }), d);

		expect(Array.from(png)).toEqual([1, 2, 3]);
		expect(d.asked[0]).toEqual({ x: 0, y: 40, width: 640, height: 360 });
	});

	it("says so plainly when there is no desktop to capture from", async () => {
		const d: CaptureDeps = { pixelRatio: 1, webContents: () => undefined };
		await expect(captureFrame(bounds({}), d)).rejects.toThrow(FrameCaptureError);
	});

	it("refuses a player too small to be a frame", async () => {
		// A collapsed pane would otherwise write a 2×2 image into the note.
		await expect(captureFrame(bounds({ width: 4, height: 4 }), deps())).rejects.toThrow(/too small/i);
	});

	it("fails rather than writing an empty image", async () => {
		/*
		 * A blank frame in a note is worse than no frame: you do not notice until the video is
		 * long closed and the moment is gone.
		 */
		await expect(captureFrame(bounds({}), deps(new Uint8Array()))).rejects.toThrow(/empty/i);
	});
});
