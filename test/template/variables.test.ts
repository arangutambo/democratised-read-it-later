import { describe, expect, it } from "vitest";

import type { Highlight, SourceRecord } from "../../src/core/types";
import { DEFAULT_HIGHLIGHTS_TEMPLATE, render } from "../../src/template/engine";
import { buildVariables } from "../../src/template/variables";

const source: SourceRecord = {
	id: "ASSET1",
	sourceType: "books",
	citekey: "houselpsychologymoney",
	title: "The Psychology of Money",
	csl: {
		type: "book",
		title: "The Psychology of Money",
		author: [{ family: "Housel", given: "Morgan" }],
		issued: { "date-parts": [[2020]] },
	},
	deepLink: "ibooks://assetid/ASSET1",
	state: "inbox",
};

const highlight: Highlight = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	sourceId: "ASSET1",
	text: "Doing well with money",
	colour: "books:3",
	note: "worth revisiting",
	chapter: "Chapter 1",
	created: "2024-01-01T00:00:00.000Z",
	state: "active",
	anchors: { quote: { exact: "Doing well with money", prefix: "", suffix: "" }, cfi: "epubcfi(/6/2)" },
};

describe("the Zotero Integration variable contract", () => {
	// These names are a compatibility promise: templates published for
	// obsidian-zotero-integration must work unchanged. Renaming any of them is a breaking
	// change to other people's files, which is why this test asserts the names themselves.
	it("exposes every documented top-level variable", () => {
		const v = buildVariables(source, [highlight]);

		for (const key of [
			"title", "citekey", "authors", "year", "publicationTitle", "doi", "url",
			"abstractNote", "allTags", "itemType", "pdfZoteroLink", "annotations",
		]) {
			expect(v, `missing contract variable: ${key}`).toHaveProperty(key);
		}
	});

	it("exposes every documented annotation variable", () => {
		const [a] = buildVariables(source, [highlight]).annotations;

		for (const key of [
			"annotatedText", "colorCategory", "page", "comment", "imageRelativePath", "id",
		]) {
			expect(a, `missing contract variable: annotation.${key}`).toHaveProperty(key);
		}
		expect(a.attachment).toHaveProperty("itemKey");
	});

	it("namespaces our own additions under reader.", () => {
		const v = buildVariables(source, [highlight]);
		expect(v.reader.sourceType).toBe("books");
		expect(v.reader.highlightCount).toBe(1);
		expect(v.reader.sourceId).toBe("ASSET1");
	});

	it("formats authors and year from CSL", () => {
		const v = buildVariables(source, [highlight]);
		expect(v.authors).toBe("Morgan Housel");
		expect(v.firstAuthor).toBe("Morgan Housel");
		expect(v.year).toBe("2020");
	});

	it("resolves colour meaning through the user's own mapping", () => {
		const resolve = (raw?: string) =>
			raw === "books:3" ? { name: "Key claim", css: "#ffd60a" } : { name: "", css: "" };

		const [a] = buildVariables(source, [highlight], resolve).annotations;
		expect(a.colorCategory).toBe("Key claim");
	});

	it("leaves colour meaning empty when the user has defined none", () => {
		const [a] = buildVariables(source, [highlight]).annotations;
		expect(a.colorCategory).toBe("");
	});

	it("survives a source with almost no metadata", () => {
		const bare: SourceRecord = {
			id: "X", sourceType: "books", citekey: "untitled", title: "Untitled",
			csl: { type: "book" }, state: "needs-review",
		};
		const v = buildVariables(bare, []);
		expect(v.authors).toBe("");
		expect(v.year).toBe("");
		expect(v.annotations).toEqual([]);
	});
});

describe("default highlights template", () => {
	it("renders a blockquote carrying a block id", () => {
		const out = render(DEFAULT_HIGHLIGHTS_TEMPLATE, buildVariables(source, [highlight]));
		expect(out).toContain("> Doing well with money");
		expect(out).toContain("^hl-01arz3ndektsv4rrffq69g5fav");
		expect(out).toContain("worth revisiting");
	});

	it("renders multi-line highlights as fully quoted blocks", () => {
		const multi = { ...highlight, text: "first line\nsecond line" };
		const out = render(DEFAULT_HIGHLIGHTS_TEMPLATE, buildVariables(source, [multi]));
		expect(out).toContain("> first line\n> second line");
	});

	it("renders nothing for a source with no highlights", () => {
		expect(render(DEFAULT_HIGHLIGHTS_TEMPLATE, buildVariables(source, [])).trim()).toBe("");
	});
});
