import { describe, expect, it } from "vitest";

import { isVideoUrl, videoIdFrom, watchUrl } from "../../src/video/id";

const ID = "t_Y_CxqRzh0";

describe("videoIdFrom", () => {
	it("reads a plain watch URL", () => {
		expect(videoIdFrom(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
	});

	it("ignores the tracking parameters a share sheet adds", () => {
		// This is the form the export's URL column actually holds.
		expect(videoIdFrom(`https://youtube.com/watch?v=${ID}&si=WjcPEcNQ_ncp8VjO`)).toBe(ID);
	});

	it("unwraps a redirect from a search result", () => {
		/*
		 * A link copied out of Google arrives wrapped, with the real URL inside an encoded
		 * parameter — the id appears nowhere in the outer URL, so a regex over the whole string
		 * finds nothing.
		 */
		const wrapped =
			"https://www.google.com/url?sa=t&source=web&rct=j&url=https://www.youtube.com/watch%3Fv%3D" +
			`${ID}&ved=2ahUKEwj7&usg=AOvVaw2GGw3HaJ9R2snoFkChUSvy`;

		expect(videoIdFrom(wrapped)).toBe(ID);
	});

	it("reads a short link", () => {
		expect(videoIdFrom(`https://youtu.be/${ID}?t=42`)).toBe(ID);
	});

	it("reads embed, shorts, live and /v/ forms", () => {
		for (const path of ["embed", "shorts", "live", "v"]) {
			expect(videoIdFrom(`https://www.youtube.com/${path}/${ID}`)).toBe(ID);
		}
	});

	it("reads the mobile and no-cookie hosts", () => {
		expect(videoIdFrom(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
		expect(videoIdFrom(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
	});

	it("accepts a bare id, so a second call on its own output is stable", () => {
		expect(videoIdFrom(ID)).toBe(ID);
	});

	it("works without a scheme", () => {
		expect(videoIdFrom(`youtube.com/watch?v=${ID}`)).toBe(ID);
	});

	it("refuses anything that is not a video", () => {
		for (const input of [
			"",
			"   ",
			"not a url",
			"https://example.com/watch?v=t_Y_CxqRzh0",
			"https://www.youtube.com/results?search_query=x",
			`https://www.youtube.com/watch?v=${ID}toolong`,
			"https://www.youtube.com/watch?v=short",
		]) {
			expect(videoIdFrom(input)).toBeUndefined();
		}
	});

	it("does not mistake a channel page for a video", () => {
		expect(videoIdFrom("https://www.youtube.com/@someone")).toBeUndefined();
	});
});

describe("watchUrl", () => {
	it("is canonical, whatever came in", () => {
		expect(watchUrl(videoIdFrom(`https://youtu.be/${ID}?t=9`) as string)).toBe(
			`https://www.youtube.com/watch?v=${ID}`,
		);
	});
});

describe("isVideoUrl", () => {
	it("recognises what Reader can open", () => {
		expect(isVideoUrl(`https://youtu.be/${ID}`)).toBe(true);
		expect(isVideoUrl("https://example.com")).toBe(false);
	});
});
