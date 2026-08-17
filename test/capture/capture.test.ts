import { describe, expect, it } from "vitest";

import {
	CaptureError,
	makeClip,
	normaliseRect,
	tidyQuote,
	unmappableRatio,
	UNMAPPABLE_LIMIT,
} from "../../src/capture/capture";
import type { CaptureRequest } from "../../src/capture/types";

const CONTEXT = {
	documentId: "doc-1",
	now: () => Date.parse("2026-08-14T04:00:00.000Z"),
	newId: () => "01K9ABCDEFGHJKMNPQRSTVWXYZ",
};

function request(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
	return {
		kind: "quote",
		locator: { surface: { kind: "pdf-page", index: 12 } },
		text: "some selected text",
		...overrides,
	};
}

describe("normaliseRect", () => {
	it("keeps a rect that is already inside the page", () => {
		expect(normaliseRect([0.1, 0.2, 0.5, 0.3])).toEqual([0.1, 0.2, 0.5, 0.3]);
	});

	it("clamps a drag that ran off the edge of the page", () => {
		// Dragging past the page boundary is normal — you start inside and overshoot.
		expect(normaliseRect([0.8, 0.9, 0.5, 0.5])).toEqual([0.8, 0.9, 0.2, 0.1]);
	});

	it("rejects a click that never became a drag", () => {
		// Without this a mis-click writes a 0x0 PNG and a bullet pointing at nothing.
		expect(normaliseRect([0.5, 0.5, 0, 0])).toBeUndefined();
	});

	it("rejects a rect entirely off the page", () => {
		expect(normaliseRect([1, 1, 0.5, 0.5])).toBeUndefined();
	});

	it("rejects non-finite values rather than propagating NaN into a filename", () => {
		expect(normaliseRect([Number.NaN, 0, 0.5, 0.5])).toBeUndefined();
		expect(normaliseRect([0, 0, Number.POSITIVE_INFINITY, 0.5])).toBeUndefined();
	});
});

describe("tidyQuote", () => {
	it("collapses the newline a PDF text layer emits per line box", () => {
		expect(tidyQuote("first line\nsecond line")).toBe("first line second line");
	});

	it("rejoins a word hyphenated across a line break", () => {
		// "converg- ence" is a rendering artefact of justification, not part of the word.
		expect(tidyQuote("the converg-\nence criterion")).toBe("the convergence criterion");
	});

	it("leaves a genuine hyphenated compound alone", () => {
		expect(tidyQuote("a well-known result")).toBe("a well-known result");
	});

	it("trims surrounding whitespace", () => {
		expect(tidyQuote("   padded   ")).toBe("padded");
	});
});

describe("makeClip", () => {
	it("builds a quote clip with a tidied text and an id", () => {
		const clip = makeClip(request({ text: "wrapped\nquote" }), CONTEXT);

		expect(clip).toMatchObject({
			id: "01K9ABCDEFGHJKMNPQRSTVWXYZ",
			documentId: "doc-1",
			kind: "quote",
			text: "wrapped quote",
			created: "2026-08-14T04:00:00.000Z",
		});
	});

	it("refuses a quote clip with nothing selected", () => {
		expect(() => makeClip(request({ text: "   " }), CONTEXT)).toThrow(CaptureError);
	});

	it("refuses an image clip with nowhere to put the file", () => {
		const image = request({ kind: "image", text: undefined });
		expect(() => makeClip(image, CONTEXT)).toThrow(CaptureError);
	});

	it("builds an image clip pointing at the supplied asset", () => {
		const image = request({ kind: "image", text: undefined, locator: { surface: { kind: "pdf-page", index: 3 }, rect: [0.1, 0.1, 0.2, 0.2] } });
		const clip = makeClip(image, CONTEXT, "Sources/_assets/x/p3.png");

		expect(clip.kind).toBe("image");
		expect(clip.assetPath).toBe("Sources/_assets/x/p3.png");
	});

	it("normalises the rect on the way in", () => {
		const image = request({ kind: "image", text: undefined, locator: { surface: { kind: "pdf-page", index: 3 }, rect: [0.9, 0.9, 0.5, 0.5] } });
		expect(makeClip(image, CONTEXT, "a.png").locator.rect).toEqual([0.9, 0.9, 0.1, 0.1]);
	});

	it("drops a degenerate rect rather than storing an unusable one", () => {
		const image = request({ kind: "image", text: undefined, locator: { surface: { kind: "pdf-page", index: 3 }, rect: [0.5, 0.5, 0, 0] } });
		expect(makeClip(image, CONTEXT, "a.png").locator.rect).toBeUndefined();
	});

	it("does not mutate the request's locator", () => {
		// The view reuses its locator between gestures; mutating it here would make the
		// second clip inherit the first one's clamping.
		const locator = { surface: { kind: "pdf-page" as const, index: 3 }, rect: [0.9, 0.9, 0.5, 0.5] as const };
		makeClip(request({ kind: "image", text: undefined, locator }), CONTEXT, "a.png");

		expect(locator.rect).toEqual([0.9, 0.9, 0.5, 0.5]);
	});
});

/**
 * Typeset maths, and why a quote of it is refused.
 *
 * LaTeX draws maths from Computer Modern fonts whose glyphs often carry no Unicode mapping.
 * Inline maths survives — `v · w = v1 w1 + v2 w2` extracts readably, if flattened. Displayed
 * maths does not, and a quote of a column vector arrived in the note as
 * `v =⃝⃝⃝⃝⃝v1v2...vn⃝⃝⃝⃝⃝`. Those characters are not in the file to recover.
 */
describe("unmappableRatio", () => {
	it("is zero for ordinary prose", () => {
		expect(unmappableRatio("Gibbs sampling converges to a local optimum.")).toBe(0);
	});

	it("is zero for inline maths, which extracts fine", () => {
		// Taken from the workbook: subscripts flatten, but every character is real.
		expect(unmappableRatio("v · w = v1 w1 + v2 w2 .")).toBe(0);
	});

	it("catches the combining enclosures a displayed column vector produces", () => {
		const real = "v =⃝⃝⃝⃝⃝v1v2...vn⃝⃝⃝⃝⃝";
		expect(unmappableRatio(real)).toBeGreaterThan(UNMAPPABLE_LIMIT);
	});

	it("catches replacement characters", () => {
		expect(unmappableRatio("���� abc")).toBeGreaterThan(UNMAPPABLE_LIMIT);
	});

	it("catches private-use glyphs", () => {
		expect(unmappableRatio(" abc")).toBeGreaterThan(UNMAPPABLE_LIMIT);
	});

	it("tolerates a single stray glyph in a good sentence", () => {
		// A lone ligature failure is not a reason to refuse a whole paragraph.
		const sentence = `A sentence of perfectly ordinary length with one bad glyph � in it.`;
		expect(unmappableRatio(sentence)).toBeLessThan(UNMAPPABLE_LIMIT);
	});

	it("is zero for an empty selection rather than dividing by zero", () => {
		expect(unmappableRatio("")).toBe(0);
	});
});
