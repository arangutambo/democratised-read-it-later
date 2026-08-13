import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPdf, obsidianPdfJs, PdfUnavailableError, type PdfJsLib } from "../../../src/sources/slides/extract";
import { toLines } from "../../../src/sources/slides/layout";
import { buildSlides } from "../../../src/sources/slides/structure";

/**
 * The extraction adapter, exercised for real.
 *
 * Until pdf.js became injectable this file could not exist: every line of `extract.ts` only
 * ran inside a live Obsidian window, which is how a CORS failure and a removed `destroy()`
 * both reached one. `pdfjs-dist` is a devDependency and is never shipped — production uses
 * Obsidian's own copy through `obsidianPdfJs()`.
 *
 * The deck below is real coursework and is gitignored, so these tests skip when it is
 * absent. Their value is precisely that the input is real; a synthetic PDF would exercise a
 * generator's idea of a PDF rather than the ones this plugin has to survive.
 */

const REAL_DECK = path.join(
	process.env.HOME ?? "",
	"Downloads",
	"BINF7001_2026_WEEK1_IntroductoryLecture.pdf",
);

const hasRealDeck = existsSync(REAL_DECK);
const withDeck = hasRealDeck ? describe : describe.skip;

async function nodePdfJs(): Promise<PdfJsLib> {
	// The legacy build is the one that runs outside a browser.
	return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsLib;
}

describe("obsidianPdfJs", () => {
	it("reports a usable error when Obsidian's engine is absent", () => {
		// In Node there is no window.pdfjsLib, which is exactly the shape of the failure a
		// future Obsidian release would produce.
		expect(() => obsidianPdfJs()).toThrow(PdfUnavailableError);
		expect(() => obsidianPdfJs()).toThrow(/window\.pdfjsLib/);
	});
});

withDeck("extractPdf against a real lecture deck", () => {
	it("extracts every page", async () => {
		const result = await extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs() });

		expect(result.pageCount).toBe(19);
		expect(result.pages).toHaveLength(19);
	});

	it("cleans up without throwing, on the pdf.js the tests run against", async () => {
		// The bug this pins: PDFDocumentProxy.destroy() is gone by pdf.js v6, and calling it
		// in a finally block throws a TypeError that replaces the real return value.
		await expect(extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs() })).resolves.toBeDefined();
	});

	it("produces items the layout code can turn back into readable lines", async () => {
		const result = await extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs() });
		const lines = toLines(result.pages[0]);

		// The real title slide, with the words actually separated.
		expect(lines[0].text).toBe("BINF7001 Advanced");
		expect(lines.map((l) => l.text).join(" ")).toContain("Genome Informatics");
		expect(lines.some((l) => l.text.includes("scott.beatson@uq.edu.au"))).toBe(true);
	});

	it("reads coordinates in PDF orientation, so lines come out top-first", async () => {
		const result = await extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs() });
		const lines = toLines(result.pages[0]);

		const ys = lines.map((l) => l.y);
		expect(ys).toEqual([...ys].sort((a, b) => b - a));
	});

	it("carries font size through, which is what title detection depends on", async () => {
		const result = await extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs() });
		const lines = toLines(result.pages[0]);

		expect(lines[0].size).toBeGreaterThan(lines[lines.length - 1].size);
	});

	it("feeds structure detection well enough to find the title slide", async () => {
		const result = await extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs() });
		const slides = buildSlides(result.pages.map(toLines));

		expect(slides[0].kind).toBe("title");
		// 17 of 19, not all: slides 3 and 4 lead with a bare slide number, which is correctly
		// not treated as a heading. Poppler produces the same 17, so the two independent
		// extractors agree — which is the point of running this against the real adapter.
		expect(slides.filter((s) => s.title).length).toBe(17);
	});

	it("reports progress and can be cancelled", async () => {
		const seen: number[] = [];
		await extractPdf(readFileSync(REAL_DECK), {
			pdfjs: await nodePdfJs(),
			onProgress: (page) => seen.push(page),
		});
		expect(seen).toHaveLength(19);

		const controller = new AbortController();
		controller.abort();
		await expect(
			extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs(), signal: controller.signal }),
		).rejects.toThrow();
	});

	it("reads document metadata", async () => {
		const result = await extractPdf(readFileSync(REAL_DECK), { pdfjs: await nodePdfJs() });
		expect(result.metadata.title).toContain("BINF7001");
	});
});
