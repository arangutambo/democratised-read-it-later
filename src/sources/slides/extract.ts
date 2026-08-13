/**
 * PDF text extraction via Obsidian's own bundled pdf.js.
 *
 * Obsidian exposes `window.pdfjsLib` with its worker already configured — its PDF viewer is
 * pdf.js — so extraction costs no dependency and no bundle growth. That is worth roughly a
 * megabyte compared with shipping `pdfjs-dist` and its worker.
 *
 * The catch is that this is **not a public API**. It can disappear or change shape between
 * Obsidian releases, so every access is guarded and failure is reported rather than thrown
 * as an unhelpful TypeError. There is no fallback: if it goes, the honest answer is that
 * this Obsidian version cannot be supported until the plugin is updated.
 *
 * Documents are always destroyed in a `finally`. A leaked PDF document holds its worker
 * transport open, which is exactly the class of leak PLAN.md §6 exists to prevent.
 */

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
	destroy(): Promise<void>;
}

interface PdfJsLib {
	getDocument(source: { data: ArrayBuffer } | Uint8Array): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

export class PdfUnavailableError extends Error {}

function getPdfJs(): PdfJsLib {
	const lib = (window as unknown as { pdfjsLib?: PdfJsLib }).pdfjsLib;
	if (!lib || typeof lib.getDocument !== "function") {
		throw new PdfUnavailableError(
			"Obsidian's PDF engine could not be reached (window.pdfjsLib). " +
				"Open any PDF in Obsidian once and try again; if it keeps failing, this Obsidian " +
				"version may have changed and Reader needs updating.",
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

export async function extractPdf(data: ArrayBuffer, options: ExtractOptions = {}): Promise<ExtractedPdf> {
	const { signal, onProgress, chunkSize = DEFAULT_CHUNK } = options;
	const pdfjs = getPdfJs();

	const task = pdfjs.getDocument({ data });
	let document: PdfDocument | undefined;

	try {
		document = await task.promise;

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
		// A leaked document keeps its worker transport alive.
		if (document) await document.destroy().catch(() => {});
		else await task.destroy().catch(() => {});
	}
}
