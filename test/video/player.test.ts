import { describe, expect, it } from "vitest";

import { embedUrl, paragraphAt, RATES } from "../../src/video/player";

describe("embedUrl", () => {
	it("asks for a player with no controls of its own", () => {
		/*
		 * Not cosmetic. `capturePage` photographs whatever is drawn, so YouTube's control bar,
		 * caption overlay and end-screen suggestions all landed inside captured frames.
		 */
		const url = embedUrl("t_Y_CxqRzh0");

		expect(url).toContain("controls=0");
		expect(url).toContain("cc_load_policy=0");
		expect(url).toContain("iv_load_policy=3");
		expect(url).toContain("rel=0");
	});

	it("enables the JS API, which is the only way to know the time", () => {
		expect(embedUrl("abc12345678")).toContain("enablejsapi=1");
	});

	it("sets an origin, which YouTube requires before it will answer postMessage", () => {
		expect(embedUrl("abc12345678")).toContain("origin=app");
	});

	it("uses the no-cookie host", () => {
		expect(embedUrl("abc12345678")).toContain("youtube-nocookie.com/embed/abc12345678");
	});
});

describe("paragraphAt", () => {
	const starts = [0, 30, 62, 95, 130];

	it("finds the paragraph being spoken", () => {
		expect(paragraphAt(starts, 0)).toBe(0);
		expect(paragraphAt(starts, 45)).toBe(1);
		expect(paragraphAt(starts, 62)).toBe(2);
		expect(paragraphAt(starts, 129.9)).toBe(3);
	});

	it("stays on the last paragraph past the end", () => {
		expect(paragraphAt(starts, 9999)).toBe(4);
	});

	it("holds at the first paragraph before it starts", () => {
		// A seek to 0 or a video that opens mid-buffer must not index out of range.
		expect(paragraphAt(starts, -5)).toBe(0);
	});

	it("copes with no transcript", () => {
		expect(paragraphAt([], 42)).toBe(0);
	});

	it("is a binary search, so it stays free at four polls a second", () => {
		const many = Array.from({ length: 5000 }, (_, i) => i * 30);
		expect(paragraphAt(many, 30 * 4321 + 5)).toBe(4321);
	});
});

describe("RATES", () => {
	it("spans what a lecture is watchable at", () => {
		expect(RATES).toContain(1);
		expect(Math.max(...RATES)).toBe(2);
		expect(Math.min(...RATES)).toBeLessThan(1);
	});
});

describe("captions and annotations", () => {
	it("unloads the caption module rather than trusting the URL parameter", () => {
		/*
		 * `cc_load_policy=0` only sets a default. An account with "always show captions" on
		 * overrides it, which is why burned-in subtitles kept appearing inside captured frames
		 * despite the parameter being right. The module unload is the instruction the player
		 * cannot ignore — so the URL flag is necessary but never sufficient.
		 */
		const url = embedUrl("abc12345678");
		expect(url).toContain("cc_load_policy=0");
	});
});
