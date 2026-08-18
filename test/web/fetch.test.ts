import { describe, expect, it } from "vitest";

import { fileNameFor, isSaveableUrl, normaliseUrl } from "../../src/web/fetch";

describe("isSaveableUrl", () => {
	it("accepts http and https", () => {
		expect(isSaveableUrl("https://example.com/a")).toBe(true);
		expect(isSaveableUrl("http://example.com")).toBe(true);
	});

	it("refuses schemes that would read the user's own disk", () => {
		// Inside Electron these reach the filesystem, and the string came from a paste box.
		for (const url of ["file:///etc/passwd", "app://obsidian.md/x", "javascript:alert(1)", "data:text/html,x"]) {
			expect(isSaveableUrl(url)).toBe(false);
		}
	});

	it("refuses nonsense", () => {
		expect(isSaveableUrl("")).toBe(false);
		expect(isSaveableUrl("not a url")).toBe(false);
	});
});

describe("normaliseUrl", () => {
	it("assumes https for a bare host", () => {
		expect(normaliseUrl("example.com/a")).toBe("https://example.com/a");
	});

	it("leaves an explicit scheme alone", () => {
		expect(normaliseUrl("http://example.com")).toBe("http://example.com");
	});
});

describe("fileNameFor", () => {
	it("strips what a vault path cannot hold", () => {
		expect(fileNameFor('Stats: a "primer"/guide', "https://x.com")).toBe("Stats- a -primer--guide");
	});

	it("falls back to the host when the title is only punctuation", () => {
		// `///` sanitises to `---`, which is not empty but is a terrible filename.
		expect(fileNameFor("///", "https://www.example.com/a")).toBe("example.com");
	});

	it("truncates a title that runs to a sentence", () => {
		expect(fileNameFor("x".repeat(300), "https://x.com").length).toBeLessThanOrEqual(100);
	});
});
