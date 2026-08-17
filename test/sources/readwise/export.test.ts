import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	importable,
	matchFilename,
	parseCsv,
	parseExport,
	parseTags,
	stateFor,
} from "../../../src/sources/readwise/export";

const REAL = path.resolve(process.cwd(), "test/private/readwise/export.csv");

describe("parseCsv", () => {
	it("reads plain rows", () => {
		expect(parseCsv("a,b\n1,2\n")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("keeps a comma inside a quoted field", () => {
		// Article titles contain commas constantly; splitting on them imports almost correctly,
		// which is the worst outcome because it looks like it worked.
		expect(parseCsv('title,url\n"Bias, variance and you",http://x')).toEqual([
			["title", "url"],
			["Bias, variance and you", "http://x"],
		]);
	});

	it("unescapes a doubled quote", () => {
		expect(parseCsv('a\n"She said ""no"""')).toEqual([["a"], ['She said "no"']]);
	});

	it("keeps a newline inside a quoted field", () => {
		expect(parseCsv('a\n"line one\nline two"')).toEqual([["a"], ["line one\nline two"]]);
	});

	it("treats CRLF as one row break", () => {
		expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("strips a byte-order mark from the first column name", () => {
		expect(parseCsv("﻿Title,URL\n")[0][0]).toBe("Title");
	});
});

describe("parseTags", () => {
	it("reads the Python list literal Readwise writes", () => {
		expect(parseTags("['youtube', 'favorite']")).toEqual(["youtube", "favorite"]);
	});

	it("is empty for no tags", () => {
		expect(parseTags("")).toEqual([]);
		expect(parseTags("[]")).toEqual([]);
	});
});

describe("stateFor", () => {
	it("maps Readwise's locations onto Reader's states", () => {
		expect(stateFor("archive")).toBe("archived");
		expect(stateFor("shortlist")).toBe("reading");
		expect(stateFor("new")).toBe("inbox");
		expect(stateFor("later")).toBe("inbox");
		expect(stateFor("feed")).toBe("feed");
	});
});

describe("importable", () => {
	const docs = [
		{ id: "1", location: "new", seen: true },
		{ id: "2", location: "feed", seen: false },
		{ id: "3", location: "archive", seen: true },
	] as Parameters<typeof importable>[0];

	it("leaves the feed out by default", () => {
		// 3,443 of 5,542 rows in a real export. Importing it wholesale is v1's bulk-extraction
		// mistake at that scale.
		expect(importable(docs).map((d) => d.id)).toEqual(["1", "3"]);
	});

	it("includes the feed when asked", () => {
		expect(importable(docs, { includeFeed: true })).toHaveLength(3);
	});
});

describe("matchFilename", () => {
	it("matches on the id, not the title", () => {
		/*
		 * Readwise names files `<title> (<id>).<ext>` with the title sanitised for a filesystem,
		 * so two documents can share a mangled title and only the id is reliable.
		 */
		const files = [
			"Getting Started with Reader (01h06f724wrm27rs2w142tt4xq).html",
			"Wild Mushrooming (01hbz079n75sj4kqbmrssg12nj).pdf",
		];

		expect(matchFilename(files, "01hbz079n75sj4kqbmrssg12nj")).toContain("Wild Mushrooming");
		expect(matchFilename(files, "nope")).toBeUndefined();
	});
});

/**
 * The real export, which is the only place the CSV's actual shape is settled.
 *
 * Gitignored, so this skips where it is absent — loudly, because a silently skipped test that
 * reports green is how this suite once stopped exercising the PDF extractor entirely.
 */
const hasReal = existsSync(REAL);
if (!hasReal) {
	console.warn("\n  ⚠  test/private/readwise/export.csv is absent — real-export tests SKIPPED.\n");
}

(hasReal ? describe : describe.skip)("the real export", () => {
	const docs = () => parseExport(readFileSync(REAL, "utf8"));

	it("reads every row", () => {
		// 5,542 rows, and a parser that splits on commas produces a different number.
		expect(docs().length).toBeGreaterThan(5000);
	});

	it("gives every document an id, a title and a location", () => {
		const all = docs();
		expect(all.every((d) => d.id !== "")).toBe(true);
		expect(all.filter((d) => d.title === "").length).toBeLessThan(all.length * 0.02);
	});

	it("finds the four locations Readwise actually uses", () => {
		const seen = new Set(docs().map((d) => d.location));
		expect([...seen].sort()).toEqual(["archive", "feed", "later", "new"]);
	});

	it("is mostly feed, which is why the feed is excluded by default", () => {
		const all = docs();
		const kept = importable(all);

		expect(all.length - kept.length).toBeGreaterThan(3000);
		expect(kept.length).toBeLessThan(all.length);
	});

	it("reads reading progress as a fraction", () => {
		const all = docs();
		expect(all.every((d) => d.progress >= 0 && d.progress <= 1)).toBe(true);
		expect(all.some((d) => d.progress > 0)).toBe(true);
	});

	it("recovers the tags that are there", () => {
		expect(docs().filter((d) => d.tags.includes("youtube")).length).toBeGreaterThan(100);
	});
});
