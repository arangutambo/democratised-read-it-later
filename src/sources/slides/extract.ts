/**
 * PDF text extraction via Obsidian's own bundled pdf.js.
 *
 * The engine access, the buffer-copy discipline and the loading-task teardown all live in
 * `reader/pdfjs.ts`, which the Reader view shares — the rules are identical and learning one
 * of them in two places is how v1 rebuilt a fixed bug without its fix.
 *
 * What remains here is the extraction itself: text with positions, used now for the outline
 * sidebar and for suggesting clip boundaries rather than for generating a note wholesale.
 */

import {
	obsidianPdfJs,
	PdfUnavailableError,
	privateCopy,
	type PdfJsLib,
	type PdfTextItem,
} from "../../reader/pdfjs";

import type { TextItem } from "./layout";

export { obsidianPdfJs, PdfUnavailableError };
export type { PdfJsLib };

export interface PdfMetadata {
	title?: string;
	author?: string;
	subject?: string;
	creationDate?: string;
}

export interface PageSize {
	width: number;
	height: number;
}

export interface ExtractedPdf {
	pageCount: number;
	/** One entry per page, in page order. */
	pages: TextItem[][];
	/** Page dimensions in PDF units — landscape means slides, portrait means a document. */
	sizes: PageSize[];
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

	// pdf.js transfers what it is given to its worker, detaching it here. See privateCopy().
	const bytes = privateCopy(data);

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
		const sizes: PageSize[] = [];

		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			if (signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");

			const page = await document.getPage(pageNumber);
			try {
				const content = await page.getTextContent();
				pages.push(toTextItems(content.items));
				try {
					const viewport = page.getViewport({ scale: 1 });
					sizes.push({ width: viewport.width, height: viewport.height });
				} catch {
					// Older pdf.js, or an unusual page: shape detection falls back to text density.
					sizes.push({ width: 0, height: 0 });
				}
			} finally {
				page.cleanup?.();
			}

			onProgress?.(pageNumber, document.numPages);
			// A 47-page deck would otherwise hold the main thread for its whole extraction.
			if (pageNumber % chunkSize === 0) await yieldToEventLoop();
		}

		return { pageCount: document.numPages, pages, sizes, metadata };
	} finally {
		// Destroying the loading task tears down the document and its worker transport. A
		// leaked task keeps that transport open. Errors here are swallowed deliberately: a
		// cleanup failure must not replace the real result or the real error.
		await task.destroy().catch(() => {});
	}
}
