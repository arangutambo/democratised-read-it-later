import { describe, expect, it } from "vitest";

import type { TextQuoteSelector } from "../../src/core/types";
import { resolveQuote } from "../../src/anchor/resolve";
import { describeQuote } from "../../src/anchor/selector";

const DOC =
	"Working memory is limited. Cowan argued that the true capacity is about four chunks, " +
	"however the estimate depends on the task. Later work refined this, however the core " +
	"claim survived replication.";

function selectorFor(quote: string, doc = DOC): TextQuoteSelector {
	const start = doc.indexOf(quote);
	if (start === -1) throw new Error(`fixture error: "${quote}" not in document`);
	return describeQuote(doc, start, start + quote.length);
}

describe("resolveQuote", () => {
	describe("exact", () => {
		it("finds an unmodified quote with full confidence", () => {
			const result = resolveQuote(DOC, selectorFor("the true capacity is about four chunks"));

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.strategy).toBe("exact");
			expect(result.score).toBe(1);
			expect(DOC.slice(result.start, result.end)).toBe("the true capacity is about four chunks");
		});

		it("uses context to pick the right one of several identical occurrences", () => {
			// The reason prefix/suffix exist: "however" appears twice here and forty times in
			// a real paper. `exact` alone cannot place it.
			const second = DOC.lastIndexOf("however");
			const selector = describeQuote(DOC, second, second + "however".length);

			const result = resolveQuote(DOC, selector);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.start).toBe(second);
		});

		it("flags ambiguity when context cannot separate occurrences", () => {
			const result = resolveQuote(DOC, { exact: "however", prefix: "", suffix: "" });

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.ambiguous).toBe(true);
		});
	});

	describe("normalised", () => {
		it("matches across reflowed whitespace", () => {
			const selector = selectorFor("the true capacity is about four chunks");
			const reflowed = DOC.replace("the true capacity is about", "the true\n  capacity\tis about");

			const result = resolveQuote(reflowed, selector);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.strategy).toBe("normalised");
			expect(reflowed.slice(result.start, result.end)).toContain("capacity");
		});

		it("matches across typographic punctuation", () => {
			// EPUB text uses ’ and “ ”; text extracted from a PDF uses ' and ". Without
			// folding, a character-correct quote orphans for no reason.
			const doc = 'She said “it depends on the task” — repeatedly.';
			const selector: TextQuoteSelector = { exact: '"it depends on the task"', prefix: "said ", suffix: " -" };

			const result = resolveQuote(doc, selector);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.strategy).toBe("normalised");
			expect(doc.slice(result.start, result.end)).toBe("“it depends on the task”");
		});
	});

	describe("fuzzy", () => {
		it("survives a typo inside the quote", () => {
			const selector = selectorFor("the true capacity is about four chunks");
			const edited = DOC.replace("capacity", "capasity");

			const result = resolveQuote(edited, selector);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.strategy).toBe("fuzzy");
			expect(edited.slice(result.start, result.end)).toContain("capasity");
		});

		it("orphans an edit beyond the 10% budget rather than mis-anchoring", () => {
			// DESIGN.md §5.1 sets the tolerance at 10% of the quote's length. Inserting
			// " separate" into a 38-character quote is 24% drift — past the budget, so this
			// must fail rather than silently attach to text the user did not highlight.
			const selector = selectorFor("the true capacity is about four chunks");
			const edited = DOC.replace("about four chunks", "about four separate chunks");

			expect(resolveQuote(edited, selector).ok).toBe(false);
		});

		it("accepts that same edit when the caller widens the budget", () => {
			const selector = selectorFor("the true capacity is about four chunks");
			const edited = DOC.replace("about four chunks", "about four separate chunks");

			const result = resolveQuote(edited, selector, { distanceRatio: 0.4 });

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.strategy).toBe("fuzzy");
		});

		it("handles quotes longer than diff-match-patch's 32-character bitap limit", () => {
			// The median real highlight is far longer than 32 characters; several exceed 400.
			const long =
				"By consistently and systematically exposing yourself to the rigors of full-range " +
				"functional movements with optimal motor control, you can quickly identify faulty " +
				"technique and holes in strength, speed, and metabolic conditioning.";
			const doc = `Chapter one. ${long} That is the method.`;
			const selector = describeQuote(doc, doc.indexOf(long), doc.indexOf(long) + long.length);

			const edited = doc.replace("quickly identify faulty", "quickly spot faulty");
			const result = resolveQuote(edited, selector);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(["fuzzy", "normalised"]).toContain(result.strategy);
			expect(edited.slice(result.start, result.end)).toContain("systematically exposing");
		});

		it("refuses a match beyond the edit budget rather than guessing", () => {
			const selector = selectorFor("the true capacity is about four chunks");
			const unrelated = "An entirely different document about marine biology and tidal patterns.";

			const result = resolveQuote(unrelated, selector);

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toBe("orphaned");
			expect(result.attempted).toContain("fuzzy");
		});
	});

	describe("offset", () => {
		it("accepts a stored offset when the text there still resembles the quote", () => {
			const doc = "aaaa The quick brown fox bbbb";
			const start = doc.indexOf("The quick brown fox");
			const selector: TextQuoteSelector = { exact: "The quick brown fx", prefix: "", suffix: "" };

			const result = resolveQuote(doc, selector, {
				hint: { start, end: start + "The quick brown fox".length },
				// Force the earlier rungs to fail so the offset rung is the one under test.
				distanceRatio: 0,
				threshold: 0,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.strategy).toBe("offset");
		});

		it("rejects a stale offset pointing at unrelated text", () => {
			// Deliberate deviation from DESIGN.md §5.1: an unguarded offset silently attaches
			// the highlight to the wrong sentence, which the user cannot see. An orphan can be
			// reviewed; a wrong anchor cannot.
			const doc = "Completely unrelated prose about tidal patterns and marine biology.";
			const selector: TextQuoteSelector = {
				exact: "the true capacity is about four chunks",
				prefix: "",
				suffix: "",
			};

			const result = resolveQuote(doc, selector, { hint: { start: 0, end: 38 } });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.attempted).toContain("offset");
		});
	});

	describe("degenerate input", () => {
		it("orphans an empty quote", () => {
			expect(resolveQuote(DOC, { exact: "", prefix: "", suffix: "" }).ok).toBe(false);
		});

		it("orphans against an empty document", () => {
			expect(resolveQuote("", selectorFor("Working memory")).ok).toBe(false);
		});

		it("resolves a quote at the very start of the document", () => {
			const result = resolveQuote(DOC, describeQuote(DOC, 0, 14));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.start).toBe(0);
		});

		it("resolves a quote at the very end of the document", () => {
			const result = resolveQuote(DOC, describeQuote(DOC, DOC.length - 12, DOC.length));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.end).toBe(DOC.length);
		});
	});
});
