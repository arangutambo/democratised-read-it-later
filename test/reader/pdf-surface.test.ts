import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PdfSurface } from "../../src/reader/surface/pdf";
import type { PdfJsLib } from "../../src/reader/pdfjs";

/**
 * `PdfSurface` against a real lecture deck.
 *
 * What can be checked in Node is everything up to the pixels: page counts, page geometry,
 * text-layer positioning, and the teardown that v1 got wrong twice. Rendering itself needs a
 * real canvas, so it is on M1's real-window checklist rather than faked here — a fake
 * canvas would assert that our own stub was called, which proves nothing.
 */
const DECK_NAME = "BINF7001_2026_WEEK1_IntroductoryLecture.pdf";
const CANDIDATES = [
	process.env.READER_TEST_DECK,
	path.join(process.env.HOME ?? "", "Documents", "🧠 Second Brain", "Sources", "_decks", DECK_NAME),
	path.join(process.env.HOME ?? "", "Documents", "🧠 Second Brain", ".trash", "Sources", "_decks", DECK_NAME),
	path.join(process.env.HOME ?? "", "Downloads", DECK_NAME),
].filter((c): c is string => typeof c === "string" && c !== "");

const REAL_DECK = CANDIDATES.find((c) => existsSync(c));
const withDeck = REAL_DECK ? describe : describe.skip;

if (!REAL_DECK) {
	console.warn(`\n  ⚠  ${DECK_NAME} not found — PdfSurface tests are SKIPPED.\n`);
}

async function nodePdfJs(): Promise<PdfJsLib> {
	return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsLib;
}

async function openDeck(): Promise<PdfSurface> {
	return PdfSurface.open(readFileSync(REAL_DECK as string), { pdfjs: await nodePdfJs() });
}

withDeck("PdfSurface", () => {
	it("reports the page count", async () => {
		const surface = await openDeck();
		try {
			expect(surface.pageCount).toBe(19);
			expect(surface.count).toBe(19);
		} finally {
			await surface.close();
		}
	});

	it("describes itself as a clippable page surface", async () => {
		const surface = await openDeck();
		try {
			// Key 3 means something on a PDF page and not on a continuous article.
			expect(surface.kind).toBe("pdf-page");
			expect(surface.wholeSurfaceIsClippable).toBe(true);
		} finally {
			await surface.close();
		}
	});

	it("reports page size in points, landscape for a slide deck", async () => {
		const surface = await openDeck();
		try {
			const size = await surface.size(1);
			expect(size.width).toBeGreaterThan(size.height);
			expect(size.width).toBeGreaterThan(100);
		} finally {
			await surface.close();
		}
	});

	it("clamps a page number outside the document rather than throwing", async () => {
		const surface = await openDeck();
		try {
			await expect(surface.size(0)).resolves.toBeDefined();
			await expect(surface.size(9999)).resolves.toBeDefined();
		} finally {
			await surface.close();
		}
	});

	it("produces a text layer positioned top-down in normalised coordinates", async () => {
		const surface = await openDeck();
		try {
			const spans = await surface.textLayer(1);

			expect(spans.length).toBeGreaterThan(0);
			expect(spans.map((s) => s.text).join(" ")).toContain("BINF7001");

			// Normalised: every span sits inside the page.
			for (const span of spans) {
				expect(span.left).toBeGreaterThanOrEqual(0);
				expect(span.left).toBeLessThanOrEqual(1);
				expect(span.top).toBeGreaterThanOrEqual(-0.01);
				expect(span.top).toBeLessThanOrEqual(1);
			}
		} finally {
			await surface.close();
		}
	});

	it("flips the y axis, because PDF counts up and the DOM counts down", async () => {
		const surface = await openDeck();
		try {
			const spans = await surface.textLayer(1);
			const title = spans.find((s) => s.text.includes("BINF7001"));
			const email = spans.find((s) => s.text.includes("@uq.edu.au"));

			// The title is above the email on the slide, so its `top` must be smaller.
			expect(title).toBeDefined();
			expect(email).toBeDefined();
			expect((title as { top: number }).top).toBeLessThan((email as { top: number }).top);
		} finally {
			await surface.close();
		}
	});

	it("closes without throwing, and closing twice is harmless", async () => {
		// The bug this pins: PDFDocumentProxy.destroy() is gone by pdf.js v6, so it is the
		// loading task that must be destroyed. A double close happens whenever the view is
		// torn down while a close is already in flight.
		const surface = await openDeck();
		await expect(surface.close()).resolves.toBeUndefined();
		await expect(surface.close()).resolves.toBeUndefined();
	});

	it("leaves the caller's bytes readable, because pdf.js detaches what it is given", async () => {
		const bytes = readFileSync(REAL_DECK as string);
		const surface = await PdfSurface.open(bytes, { pdfjs: await nodePdfJs() });
		try {
			// Without privateCopy() this throws "detached ArrayBuffer" in Obsidian.
			expect(bytes.byteLength).toBeGreaterThan(0);
			expect(bytes[0]).toBe(0x25); // '%' of %PDF
		} finally {
			await surface.close();
		}
	});
});

describe("PdfSurface.open failure", () => {
	it("destroys the loading task when the document will not open", async () => {
		let destroyed = false;
		const pdfjs = {
			getDocument: () => ({
				promise: Promise.reject(new Error("not a pdf")),
				destroy: async () => {
					destroyed = true;
				},
			}),
		} as unknown as PdfJsLib;

		// A failed open still leaves a task holding a worker transport open.
		await expect(PdfSurface.open(new Uint8Array([1, 2, 3]), { pdfjs })).rejects.toThrow("not a pdf");
		expect(destroyed).toBe(true);
	});
});
