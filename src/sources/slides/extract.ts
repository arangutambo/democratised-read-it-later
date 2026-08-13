/**
 * PDF text extraction via Obsidian's own bundled pdf.js.
 *
 * Obsidian's PDF viewer is pdf.js, and it exposes it through the public `loadPdfJs()` API
 * with the worker already configured. So extraction costs no dependency and no bundle
 * growth — worth roughly a megabyte against shipping `pdfjs-dist` and its worker.
 *
 * It has to be `loadPdfJs()` rather than `window.pdfjsLib`, because the load is **lazy**:
 * the global does not exist until something asks for it. Reading it directly failed on a
 * clean start and would have silently appeared to work for anyone who had opened a PDF
 * first — the worst kind of bug, since it depends on what the user did earlier.
 *
 * The loading task is always destroyed in a `finally`. A leaked task keeps its worker
 * transport open, which is exactly the class of leak PLAN.md §6 exists to prevent.
 */

import { loadPdfJs } from "obsidian";

import type { TextItem } from "./layout";

interface PdfTextItem {
	str?: string;
	width?: number;
	height?: number;
	/** [scaleX, skewX, skewY, scaleY, translateX, translateY] */
	transform?: number[];
}

interface PdfPage {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
	cleanup?(): void;
}

interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
	getMetadata(): Promise<{ info?: Record<string, unknown> }>;
}

interface PdfLoadingTask {
	promise: Promise<PdfDocument>;
	/**
	 * The one cleanup call that is stable across pdf.js versions, and which tears down the
	 * document with it. `PDFDocumentProxy.destroy()` existed in older releases and is gone by
	 * v6 — calling it inside a `finally` throws a TypeError that replaces whatever the
	 * function was actually returning, turning a working extraction into an unrelated error.
	 */
	destroy(): Promise<void>;
}

export interface PdfJsLib {
	getDocument(source: { data: ArrayBuffer | Uint8Array; isEvalSupported?: boolean }): PdfLoadingTask;
}

export class PdfUnavailableError extends Error {}

/**
 * Obsidian's bundled pdf.js, via its public `loadPdfJs()` API.
 *
 * Obsidian loads pdf.js **lazily**: `window.pdfjsLib` does not exist until something has
 * asked for it, which is why reading the global directly failed on a clean start and would
 * have appeared to work for anyone who happened to have opened a PDF first. `loadPdfJs()`
 * triggers the load and resolves to that same object — documented, supported, and correct
 * whether or not a PDF has been opened this session.
 *
 * Exported so tests can supply their own implementation instead: `pdfjs-dist` is a
 * devDependency used only to exercise this adapter against real decks in Node. Production
 * uses Obsidian's copy and ships no pdf.js of its own.
 */
export async function obsidianPdfJs(): Promise<PdfJsLib> {
	const lib = (await loadPdfJs()) as PdfJsLib | undefined;
	if (!lib || typeof lib.getDocument !== "function") {
		throw new PdfUnavailableError(
			"Obsidian's PDF engine could not be loaded. This Obsidian version may have changed " +
				"in a way Reader does not yet handle — please report it with your Obsidian version.",
		);
	}
	return lib;
}

export interface PdfMetadata {
	title?: string;
	author?: string;
	subject?: string;
	creationDate?: string;
}

export interface ExtractedPdf {
	pageCount: number;
	/** One entry per page, in page order. */
	pages: TextItem[][];
	metadata: PdfMetadata;
}

export interface ExtractOptions {
	signal?: AbortSignal;
	onProgress?: (page: number, total: number) => void;
	/** Pages processed between yields to the event loop. */
	chunkSize?: number;
	/**
	 * The pdf.js implementation to use. Defaults to Obsidian's.
	 *
	 * This exists so the adapter is testable at all: without it, every line below could only
	 * ever run inside a live Obsidian window, which is precisely how a CORS bug and a removed
	 * `destroy()` both reached a real window before anything caught them.
	 */
	pdfjs?: PdfJsLib;
}

const DEFAULT_CHUNK = 5;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toTextItems(items: readonly PdfTextItem[]): TextItem[] {
	const out: TextItem[] = [];
	for (const item of items) {
		const str = item.str;
		if (typeof str !== "string" || str === "") continue;
		const transform = item.transform;
		if (!Array.isArray(transform) || transform.length < 6) continue;

		out.push({
			str,
			x: transform[4],
			y: transform[5],
			// `height` is 0 for some generators; the vertical scale factor is the fallback.
			height: item.height && item.height > 0 ? item.height : Math.abs(transform[3]),
			width: item.width ?? 0,
		});
	}
	return out;
}

export async function extractPdf(
	data: ArrayBuffer | Uint8Array,
	options: ExtractOptions = {},
): Promise<ExtractedPdf> {
	const { signal, onProgress, chunkSize = DEFAULT_CHUNK } = options;
	const pdfjs = options.pdfjs ?? (await obsidianPdfJs());

	/*
	 * Normalise to a plain Uint8Array.
	 *
	 * pdf.js rejects a Node `Buffer` outright — "Please provide binary data as `Uint8Array`,
	 * rather than `Buffer`" — even though Buffer extends Uint8Array, because a pooled Buffer
	 * can be a view into a much larger allocation. Obsidian hands over an ArrayBuffer so this
	 * never bites in production, but a function that accepts bytes should accept bytes.
	 */
	const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);

	// `isEvalSupported: false` keeps pdf.js from compiling font programs with eval, which a
	// stricter Obsidian content-security policy would refuse anyway.
	const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });

	try {
		const document = await task.promise;

		const meta = await document.getMetadata().catch(() => ({}) as { info?: Record<string, unknown> });
		const info: Record<string, unknown> = meta.info ?? {};
		const metadata: PdfMetadata = {
			title: asString(info.Title),
			author: asString(info.Author),
			subject: asString(info.Subject),
			creationDate: asString(info.CreationDate),
		};

		const pages: TextItem[][] = [];

		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			if (signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");

			const page = await document.getPage(pageNumber);
			try {
				const content = await page.getTextContent();
				pages.push(toTextItems(content.items));
			} finally {
				page.cleanup?.();
			}

			onProgress?.(pageNumber, document.numPages);
			// A 47-page deck would otherwise hold the main thread for its whole extraction.
			if (pageNumber % chunkSize === 0) await yieldToEventLoop();
		}

		return { pageCount: document.numPages, pages, metadata };
	} finally {
		// Destroying the loading task tears down the document and its worker transport. A
		// leaked task keeps that transport open. Errors here are swallowed deliberately: a
		// cleanup failure must not replace the real result or the real error.
		await task.destroy().catch(() => {});
	}
}
