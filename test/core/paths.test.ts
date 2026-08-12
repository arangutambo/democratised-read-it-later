import { describe, expect, it } from "vitest";

import { joinVaultPath, sanitiseFileName } from "../../src/core/paths";

describe("sanitiseFileName", () => {
	it("keeps ordinary titles intact", () => {
		expect(sanitiseFileName("The Psychology of Money")).toBe("The Psychology of Money");
	});

	it("removes characters Obsidian would read as link syntax", () => {
		expect(sanitiseFileName("Notes #1 [draft] ^v2 | final")).toBe("Notes 1 draft v2 final");
	});

	it("removes path separators and filesystem-reserved characters", () => {
		expect(sanitiseFileName('a/b\\c:d*e?f"g<h>i')).toBe("a b c d e f g h i");
	});

	it("strips leading dots so the file is not hidden", () => {
		expect(sanitiseFileName(".hidden")).toBe("hidden");
	});

	it("strips trailing dots and spaces, which Windows silently drops", () => {
		expect(sanitiseFileName("name. ")).toBe("name");
	});

	it("escapes Windows reserved device names", () => {
		expect(sanitiseFileName("CON")).toBe("CON_");
		expect(sanitiseFileName("lpt1")).toBe("lpt1_");
	});

	it("truncates very long titles without leaving trailing punctuation", () => {
		const name = sanitiseFileName("A".repeat(300));
		expect(name.length).toBeLessThanOrEqual(120);
	});

	it("falls back when nothing usable survives", () => {
		expect(sanitiseFileName("///", "citekey123")).toBe("citekey123");
		expect(sanitiseFileName("")).toBe("Untitled");
	});

	it("handles a real title from the library", () => {
		expect(sanitiseFileName("Feel-good Productivity : How to Do More of What Matters to You (9781250865052)")).toBe(
			"Feel-good Productivity How to Do More of What Matters to You (9781250865052)",
		);
	});
});

describe("joinVaultPath", () => {
	it("joins segments and drops empties", () => {
		expect(joinVaultPath("Sources", "", "note.md")).toBe("Sources/note.md");
	});

	it("flattens segments that already contain slashes", () => {
		expect(joinVaultPath("Sources/Books", "note.md")).toBe("Sources/Books/note.md");
	});

	it("collapses redundant separators", () => {
		expect(joinVaultPath("/Sources//", "/note.md")).toBe("Sources/note.md");
	});
});
