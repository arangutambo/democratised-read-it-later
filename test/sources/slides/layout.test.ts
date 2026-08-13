import { describe, expect, it } from "vitest";

import { linesToText, toLines, type TextItem } from "../../../src/sources/slides/layout";

/** Word-shaped item, as poppler yields and as extract.ts converts pdf.js items into. */
function word(str: string, x: number, y: number, height = 10, charWidth = 6): TextItem {
	return { str, x, y, height, width: str.length * charWidth };
}

describe("toLines", () => {
	it("returns nothing for an empty or whitespace-only page", () => {
		expect(toLines([])).toEqual([]);
		expect(toLines([word("   ", 0, 100)])).toEqual([]);
	});

	it("orders lines top of page first, since PDF y grows upward", () => {
		const lines = toLines([word("bottom", 0, 10), word("top", 0, 100), word("middle", 0, 50)]);
		expect(lines.map((l) => l.text)).toEqual(["top", "middle", "bottom"]);
	});

	it("orders items within a line left to right regardless of draw order", () => {
		// Content-stream order is not reading order; a generator may emit these in any order.
		const lines = toLines([word("world", 40, 100), word("Hello", 0, 100)]);
		expect(lines[0].text).toBe("Hello world");
	});

	it("inserts spaces between words that arrive as separate items", () => {
		// The real bug: normalising the gap against line height instead of character width
		// produced "BINF7001Advanced" and "Don'tpanic" on actual lecture decks.
		const lines = toLines([word("BINF7001", 0, 100, 30, 15), word("Advanced", 128, 100, 30, 15)]);
		expect(lines[0].text).toBe("BINF7001 Advanced");
	});

	it("does not insert a space inside a word split across items", () => {
		// Kerning splits leave the pieces touching; a space here would corrupt the word.
		const lines = toLines([word("Ad", 0, 100), word("vanced", 12, 100)]);
		expect(lines[0].text).toBe("Advanced");
	});

	it("tolerates items reporting no width", () => {
		const items: TextItem[] = [
			{ str: "one", x: 0, y: 100, height: 10, width: 0 },
			{ str: "two", x: 30, y: 100, height: 10, width: 0 },
		];
		expect(toLines(items)[0].text).toBe("one two");
	});

	it("groups items whose baselines differ slightly", () => {
		// Subscripts and mixed fonts shift the baseline a little without starting a new line.
		const lines = toLines([word("H", 0, 100), word("2", 8, 98.5), word("O", 14, 100)]);
		expect(lines).toHaveLength(1);
	});

	it("separates lines that are genuinely apart", () => {
		expect(toLines([word("first", 0, 100), word("second", 0, 80)])).toHaveLength(2);
	});

	it("reports the largest glyph height on a line, which is what marks a heading", () => {
		const lines = toLines([word("BIG", 0, 100, 24), word("small", 40, 100, 10)]);
		expect(lines[0].size).toBe(24);
	});

	it("collapses runs of whitespace within a line", () => {
		expect(toLines([word("a   b", 0, 100)])[0].text).toBe("a b");
	});
});

describe("linesToText", () => {
	it("joins lines with newlines", () => {
		expect(linesToText(toLines([word("one", 0, 100), word("two", 0, 80)]))).toBe("one\ntwo");
	});

	it("is empty for no lines", () => {
		expect(linesToText([])).toBe("");
	});
});
