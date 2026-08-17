import { describe, expect, it } from "vitest";

import { joinLines, linesFromSpans, renderStructured } from "../../src/reader/gesture/structure";
import type { TextSpan } from "../../src/reader/surface/pdf";

/** A span, positioned the way pdf.js reports them: normalised, top-down. */
function span(text: string, left: number, top: number, width = 0.2, height = 0.02): TextSpan {
	return { text, left, top, width, height };
}

describe("linesFromSpans", () => {
	it("groups spans sharing a vertical position into one line", () => {
		const lines = linesFromSpans([span("world", 0.4, 0.1), span("hello", 0.1, 0.1)]);

		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("hello world");
	});

	it("orders by position, not by the order pdf.js emitted them", () => {
		/*
		 * The bug this fixes: selecting a slide heading also captured a caption from the far
		 * corner, because the text layer is absolutely positioned and DOM order is content-
		 * stream order. Geometry is the only reliable reading order.
		 */
		const lines = linesFromSpans([
			span("Test metrics", 0.6, 0.9),
			span("Bias-variance dilemma", 0.1, 0.05),
		]);

		expect(lines.map((l) => l.text)).toEqual(["Bias-variance dilemma", "Test metrics"]);
	});

	it("separates lines that are vertically apart", () => {
		const lines = linesFromSpans([span("first", 0.1, 0.1), span("second", 0.1, 0.2)]);
		expect(lines.map((l) => l.text)).toEqual(["first", "second"]);
	});

	it("inserts a space only where the geometry shows a gap", () => {
		// pdf.js splits a run wherever the font changes, which is usually mid-word.
		const joined = linesFromSpans([
			span("model", 0.1, 0.1, 0.06),
			span("parameters", 0.16, 0.1, 0.1),
		]);
		expect(joined[0].text).toBe("modelparameters");

		const spaced = linesFromSpans([
			span("model", 0.1, 0.1, 0.06),
			span("parameters", 0.2, 0.1, 0.1),
		]);
		expect(spaced[0].text).toBe("model parameters");
	});

	it("recognises a bullet glyph and turns it into a list marker", () => {
		const lines = linesFromSpans([span("• has a bias", 0.1, 0.1)]);
		expect(lines[0]).toMatchObject({ marker: "-", text: "has a bias" });
	});

	it("keeps a numbered marker verbatim", () => {
		expect(linesFromSpans([span("2. second point", 0.1, 0.1)])[0]).toMatchObject({
			marker: "2.",
			text: "second point",
		});
	});

	it("reports indentation relative to the leftmost text", () => {
		const lines = linesFromSpans([
			span("Heading", 0.1, 0.1),
			span("• nested", 0.15, 0.2),
			span("• deeper", 0.2, 0.3),
		]);

		// Levels, not distances: a deck indents by whatever its template chose.
		expect(lines.map((l) => l.indent)).toEqual([0, 1, 2]);
	});

	it("ignores whitespace-only spans", () => {
		expect(linesFromSpans([span("   ", 0.1, 0.1), span("real", 0.2, 0.1)])[0].text).toBe("real");
	});

	it("returns nothing for nothing", () => {
		expect(linesFromSpans([])).toEqual([]);
	});
});

describe("joinLines", () => {
	it("rejoins a word hyphenated across a line break", () => {
		// Otherwise the note reads "converg- ence criterion".
		const lines = [
			{ text: "the converg-", indent: 0 },
			{ text: "ence criterion", indent: 0 },
		];
		expect(joinLines(lines)).toBe("the convergence criterion");
	});

	it("leaves a hyphen that is part of a real compound", () => {
		const lines = [
			{ text: "a well-known", indent: 0 },
			{ text: "result", indent: 0 },
		];
		expect(joinLines(lines)).toBe("a well-known result");
	});

	it("does not rejoin across a capital, which is a compound not a break", () => {
		const lines = [
			{ text: "the Bias-", indent: 0 },
			{ text: "Variance tradeoff", indent: 0 },
		];
		expect(joinLines(lines)).toBe("the Bias- Variance tradeoff");
	});

	it("puts a space between lines that simply wrapped", () => {
		// The reported bug: "types ofrelations", "ifthe bias", "modelparameters".
		const lines = [
			{ text: "certain types of", indent: 0 },
			{ text: "relations between features", indent: 0 },
		];
		expect(joinLines(lines)).toBe("certain types of relations between features");
	});
});

describe("renderStructured", () => {
	it("rejoins plain prose into a sentence rather than keeping typesetting breaks", () => {
		const lines = [
			{ text: "A machine learning model", indent: 0 },
			{ text: "and algorithm", indent: 0 },
		];
		expect(renderStructured(lines)).toBe("A machine learning model and algorithm");
	});

	it("keeps a bulleted slide as a list", () => {
		// The whole point: the slide's shape is the meaning, and flattening it loses that.
		const lines = linesFromSpans([
			span("A machine learning model and algorithm", 0.1, 0.05),
			span("• has a bias, i.e. a tendency", 0.12, 0.12),
			span("• has variance to enable training", 0.12, 0.25),
		]);

		expect(renderStructured(lines)).toBe(
			"A machine learning model and algorithm\n- has a bias, i.e. a tendency\n- has variance to enable training",
		);
	});

	it("folds a wrapped bullet back into its own item", () => {
		const lines = linesFromSpans([
			span("• has a bias, i.e. a tendency to", 0.12, 0.12),
			span("pick up or miss certain types", 0.14, 0.16),
		]);

		expect(renderStructured(lines)).toBe("- has a bias, i.e. a tendency to pick up or miss certain types");
	});

	it("indents a nested list", () => {
		const lines = linesFromSpans([
			span("• outer", 0.1, 0.1),
			span("• inner", 0.15, 0.2),
		]);

		expect(renderStructured(lines)).toBe("- outer\n  - inner");
	});

	it("is empty for no lines", () => {
		expect(renderStructured([])).toBe("");
	});
});
