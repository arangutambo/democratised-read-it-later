import { describe, expect, it } from "vitest";

import {
	assessConfidence,
	buildImports,
	coreDataToIso,
	deepLink,
	deriveQuote,
	mapAnnotation,
	mapAsset,
	parseAuthors,
	type BooksAnnotationRow,
	type BooksAssetRow,
} from "../../../src/sources/books/map";

const fixedRandom = (bytes: number) => new Uint8Array(bytes).fill(0);

function annotation(overrides: Partial<BooksAnnotationRow> = {}): BooksAnnotationRow {
	return {
		assetId: "ASSET1",
		selected: "the selected text",
		uuid: "UUID-1",
		representative: null,
		note: null,
		style: 3,
		cfi: "epubcfi(/6/30!/4,/8/2/1:430,/10/2/1:54)",
		chapter: null,
		created: 0,
		modified: null,
		underline: 0,
		...overrides,
	};
}

function asset(overrides: Partial<BooksAssetRow> = {}): BooksAssetRow {
	return {
		assetId: "ASSET1",
		title: "The Psychology of Money",
		author: "Morgan Housel",
		year: 2020,
		genre: null,
		language: "en",
		pageCount: 252,
		description: null,
		path: null,
		...overrides,
	};
}

describe("coreDataToIso", () => {
	it("converts the Core Data epoch (2001-01-01) to ISO", () => {
		expect(coreDataToIso(0)).toBe("2001-01-01T00:00:00.000Z");
	});

	it("returns undefined for missing or nonsense values", () => {
		expect(coreDataToIso(null)).toBeUndefined();
		expect(coreDataToIso(NaN)).toBeUndefined();
	});
});

describe("deriveQuote", () => {
	it("recovers prefix and suffix from Apple's representative text", () => {
		// This is the real shape: representative holds the selection plus sentence context.
		const selected = "idea of a flame burning underwater";
		const representative = "Entranced by the idea of a flame burning underwater, Septimus knelt down";

		const quote = deriveQuote(selected, representative);

		expect(quote.exact).toBe(selected);
		expect(quote.prefix).toBe("Entranced by the ");
		expect(quote.suffix).toBe(", Septimus knelt down");
	});

	it("caps context at the configured window", () => {
		const selected = "middle";
		const representative = `${"a".repeat(100)}${selected}${"b".repeat(100)}`;
		const quote = deriveQuote(selected, representative);

		expect(quote.prefix).toHaveLength(32);
		expect(quote.suffix).toHaveLength(32);
	});

	it("falls back to the trimmed selection when whitespace differs", () => {
		const quote = deriveQuote("  padded  ", "before padded after");
		expect(quote.prefix).toBe("before ");
		expect(quote.suffix).toBe(" after");
	});

	it("yields empty context rather than guessing when the selection is not found", () => {
		const quote = deriveQuote("absent", "unrelated context");
		expect(quote).toEqual({ exact: "absent", prefix: "", suffix: "" });
	});

	it("yields empty context when there is no representative text at all", () => {
		expect(deriveQuote("x", null)).toEqual({ exact: "x", prefix: "", suffix: "" });
	});
});

describe("deepLink", () => {
	it("builds an ibooks:// link, with the CFI when present", () => {
		expect(deepLink("A1")).toBe("ibooks://assetid/A1");
		expect(deepLink("A1", "epubcfi(/6/2)")).toBe("ibooks://assetid/A1#epubcfi(/6/2)");
	});
});

describe("mapAnnotation", () => {
	it("maps a row to a highlight", () => {
		const h = mapAnnotation(annotation({ note: "my comment", chapter: "8 Fire" }), "ASSET1", 0, fixedRandom);

		expect(h).not.toBeNull();
		expect(h?.text).toBe("the selected text");
		expect(h?.note).toBe("my comment");
		expect(h?.chapter).toBe("8 Fire");
		expect(h?.colour).toBe("books:3");
		expect(h?.sourceUuid).toBe("UUID-1");
		expect(h?.state).toBe("active");
		expect(h?.anchors.cfi).toContain("epubcfi");
	});

	it("skips rows that are not highlights", () => {
		expect(mapAnnotation(annotation({ selected: null }), "A", 0, fixedRandom)).toBeNull();
		expect(mapAnnotation(annotation({ selected: "   " }), "A", 0, fixedRandom)).toBeNull();
	});

	it("treats blank notes and chapters as absent", () => {
		const h = mapAnnotation(annotation({ note: "   ", chapter: "" }), "A", 0, fixedRandom);
		expect(h?.note).toBeUndefined();
		expect(h?.chapter).toBeUndefined();
	});

	it("leaves colour undefined when the style column is missing", () => {
		expect(mapAnnotation(annotation({ style: null }), "A", 0, fixedRandom)?.colour).toBeUndefined();
	});
});

describe("parseAuthors", () => {
	it("parses a plain two-part name", () => {
		expect(parseAuthors("Morgan Housel")).toEqual([{ family: "Housel", given: "Morgan" }]);
	});

	it("parses `Last, First`", () => {
		expect(parseAuthors("Pease, Barbara")).toEqual([{ family: "Pease", given: "Barbara" }]);
	});

	it("strips credentials", () => {
		expect(parseAuthors("Michael Greger MD")).toEqual([{ family: "Greger", given: "Michael" }]);
	});

	it("splits multiple authors", () => {
		expect(parseAuthors("Kelly Starrett & Juliet Starrett")).toHaveLength(2);
	});

	it("uses a CSL literal rather than inventing a surname when ambiguous", () => {
		expect(parseAuthors("The Editors of Something")).toEqual([{ literal: "The Editors of Something" }]);
	});

	it("returns nothing for absent authors", () => {
		expect(parseAuthors(null)).toEqual([]);
		expect(parseAuthors("  ")).toEqual([]);
	});
});

describe("mapAsset", () => {
	it("builds a source record with CSL metadata", () => {
		const source = mapAsset(asset());

		expect(source.sourceType).toBe("books");
		expect(source.citekey).toBe("housel2020psychology");
		expect(source.csl.type).toBe("book");
		expect(source.csl.issued).toEqual({ "date-parts": [[2020]] });
		expect(source.csl.numberOfPages).toBe(252);
		expect(source.deepLink).toBe("ibooks://assetid/ASSET1");
	});

	it("survives an asset with almost no metadata", () => {
		const source = mapAsset(asset({ title: null, author: null, year: null, pageCount: null, language: null }));
		expect(source.title).toBe("Untitled");
		expect(source.csl.author).toBeUndefined();
		expect(source.csl.issued).toBeUndefined();
	});

	it("prefers a supplied citekey over a freshly derived one", () => {
		// Re-import must not recompute a key that drafts already cite.
		expect(mapAsset(asset({ title: "A New Title" }), "housel2020psychology").citekey).toBe(
			"housel2020psychology",
		);
	});
});

describe("assessConfidence", () => {
	it("is fully confident about complete metadata", () => {
		const source = mapAsset(asset());
		const highlights = [mapAnnotation(annotation({ representative: "a the selected text b" }), "A", 0, fixedRandom)!];
		const { confidence, warnings } = assessConfidence(source, highlights);

		expect(confidence).toBe(1);
		expect(warnings).toEqual([]);
	});

	it("drops confidence and explains why when metadata is missing", () => {
		const source = mapAsset(asset({ title: null, author: null, year: null }));
		const { confidence, warnings } = assessConfidence(source, []);

		expect(confidence).toBeLessThan(0.6);
		expect(warnings.join(" ")).toMatch(/title/i);
		expect(warnings.join(" ")).toMatch(/author/i);
	});

	it("warns when most highlights lack anchoring context", () => {
		const source = mapAsset(asset());
		const highlights = [mapAnnotation(annotation({ representative: null }), "A", 0, fixedRandom)!];
		const { warnings } = assessConfidence(source, highlights);

		expect(warnings.join(" ")).toMatch(/no surrounding context/i);
	});
});

describe("buildImports", () => {
	it("groups annotations under their books", () => {
		const results = buildImports(
			[asset(), asset({ assetId: "ASSET2", title: "Captivate", author: "Vanessa Van Edwards", year: 2017 })],
			[
				annotation(),
				annotation({ uuid: "UUID-2" }),
				annotation({ assetId: "ASSET2", uuid: "UUID-3" }),
			],
			{ random: fixedRandom },
		);

		expect(results).toHaveLength(2);
		const byTitle = Object.fromEntries(results.map((r) => [r.source.title, r.highlights.length]));
		expect(byTitle).toEqual({ "The Psychology of Money": 2, Captivate: 1 });
	});

	it("skips books with no highlights", () => {
		// 384 books in the library, 23 annotated — do not create 361 empty notes.
		const results = buildImports([asset(), asset({ assetId: "UNREAD", title: "Never Opened" })], [annotation()], {
			random: fixedRandom,
		});

		expect(results.map((r) => r.source.title)).toEqual(["The Psychology of Money"]);
	});

	it("keeps highlights whose book has vanished from the library, and says so", () => {
		const results = buildImports([], [annotation()], { random: fixedRandom });

		expect(results).toHaveLength(1);
		expect(results[0].highlights).toHaveLength(1);
		expect(results[0].warnings.join(" ")).toMatch(/not in the Books library/i);
	});

	it("reuses citekeys from a previous import", () => {
		const results = buildImports([asset({ title: "Retitled By Apple" })], [annotation()], {
			random: fixedRandom,
			existingCitekeys: new Map([["ASSET1", "housel2020psychology"]]),
		});

		expect(results[0].source.citekey).toBe("housel2020psychology");
	});

	it("disambiguates citekeys that would collide", () => {
		const results = buildImports(
			[
				asset({ assetId: "A", title: "Money", author: "Morgan Housel", year: 2020 }),
				asset({ assetId: "B", title: "Money", author: "Morgan Housel", year: 2020 }),
			],
			[annotation({ assetId: "A" }), annotation({ assetId: "B" })],
			{ random: fixedRandom },
		);

		const keys = results.map((r) => r.source.citekey);
		expect(new Set(keys).size).toBe(2);
		expect(keys).toContain("housel2020money");
	});
});
