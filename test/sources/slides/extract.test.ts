import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { setPdfJsForTests } from "../../stubs/obsidian";

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
	it("goes through Obsidian's public loadPdfJs(), not the lazy global", async () => {
		// window.pdfjsLib does not exist until Obsidian has loaded pdf.js, so reading it
		// directly failed on a clean start and would have appeared to work for anyone who
		// had opened a PDF first. loadPdfJs() triggers the load.
		const fake = { getDocument: () => ({ promise: Promise.resolve({}), destroy: async () => {} }) };
		setPdfJsForTests(fake);

		await expect(obsidianPdfJs()).resolves.toBe(fake);
		setPdfJsForTests(undefined);
	});

	it("reports a usable error when the load yields nothing", async () => {
		setPdfJsForTests(undefined);
		await expect(obsidianPdfJs()).rejects.toBeInstanceOf(PdfUnavailableError);
	});
});

describe("input ownership", () => {
	/**
	 * pdf.js transfers the buffer it is given to its worker, detaching it in this thread.
	 * The caller's bytes must therefore never be the bytes pdf.js receives — the deck import
	 * reads a PDF, extracts it, and then writes those same bytes into the vault, which failed
	 * with "Cannot perform Construct on a detached ArrayBuffer".
	 *
	 * A fake pdf.js is used deliberately: the real one only detaches when a worker is
	 * actually involved, so a test against pdfjs-dist in Node would pass either way. This
	 * asserts the invariant itself rather than one runtime's symptom of breaking it.
	 */
	function recordingPdfJs(seen: { data: ArrayBuffer | Uint8Array }[]): PdfJsLib {
		return {
			getDocument(source: { data: ArrayBuffer | Uint8Array }) {
				seen.push(source);
				return {
					promise: Promise.resolve({
						numPages: 0,
						getPage: () => Promise.reject(new Error("unused")),
						getMetadata: () => Promise.resolve({ info: {} }),
					}),
					destroy: async () => {},
				};
			},
		} as unknown as PdfJsLib;
	}

	it("never hands pdf.js the caller's ArrayBuffer", async () => {
		const input = new ArrayBuffer(64);
		const seen: { data: ArrayBuffer | Uint8Array }[] = [];

		await extractPdf(input, { pdfjs: recordingPdfJs(seen) });

		const given = seen[0].data as Uint8Array;
		expect(given.buffer).not.toBe(input);
		expect(given.byteLength).toBe(64);
	});

	it("never hands pdf.js the caller's typed array buffer", async () => {
		const input = new Uint8Array(64);
		const seen: { data: ArrayBuffer | Uint8Array }[] = [];

		await extractPdf(input, { pdfjs: recordingPdfJs(seen) });

		expect((seen[0].data as Uint8Array).buffer).not.toBe(input.buffer);
	});

	it("leaves the caller's bytes readable afterwards", async () => {
		const input = new Uint8Array([1, 2, 3, 4]);
		await extractPdf(input, { pdfjs: recordingPdfJs([]) });

		expect(Array.from(input)).toEqual([1, 2, 3, 4]);
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
