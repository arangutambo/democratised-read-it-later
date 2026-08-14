/**
 * Access to Obsidian's own bundled pdf.js, and the slice of its API Reader uses.
 *
 * Obsidian's PDF viewer *is* pdf.js, and it is exposed through the public `loadPdfJs()` API
 * with the worker already configured. So rendering costs no dependency and no bundle growth —
 * roughly a megabyte against shipping `pdfjs-dist` and its worker.
 *
 * Three v1 bugs live in this file's design, all of which reached a real Obsidian window:
 *
 *  - It must be `loadPdfJs()`, never `window.pdfjsLib`. The global is populated **lazily**, so
 *    reading it directly fails on a clean start and appears to work for anyone who happened to
 *    open a PDF first — a bug whose presence depends on what the user did earlier.
 *  - The **loading task** is what gets destroyed, not the document. `PDFDocumentProxy.destroy()`
 *    was removed by pdf.js v6, and calling it inside a `finally` throws a TypeError that
 *    replaces whatever the function was actually returning.
 *  - pdf.js **transfers** the buffer it is handed to its worker, detaching it in this thread.
 *    See `privateCopy()`.
 */

import { loadPdfJs } from "obsidian";

export class PdfUnavailableError extends Error {}

export interface PdfTextItem {
	str?: string;
	width?: number;
	height?: number;
	/** [scaleX, skewX, skewY, scaleY, translateX, translateY] */
	transform?: number[];
}

export interface PdfViewport {
	width: number;
	height: number;
}

export interface PdfRenderTask {
	promise: Promise<void>;
	/** Abandon an in-flight render. Scrolling fast starts more renders than it finishes. */
	cancel(): void;
}

export interface PdfPage {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
	getViewport(params: { scale: number; rotation?: number }): PdfViewport;
	render(params: { canvasContext: unknown; viewport: PdfViewport }): PdfRenderTask;
	cleanup?(): void;
}

export interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
	getMetadata(): Promise<{ info?: Record<string, unknown> }>;
}

export interface PdfLoadingTask {
	promise: Promise<PdfDocument>;
	/**
	 * The one cleanup call that is stable across pdf.js versions, and which tears down the
	 * document with it. A leaked task keeps its worker transport open.
	 */
	destroy(): Promise<void>;
}

export interface PdfJsLib {
	getDocument(source: { data: ArrayBuffer | Uint8Array; isEvalSupported?: boolean }): PdfLoadingTask;
}

/**
 * Obsidian's bundled pdf.js.
 *
 * Exported so tests can supply their own implementation instead: `pdfjs-dist` is a
 * devDependency used only to exercise this against real documents in Node. Production uses
 * Obsidian's copy and ships no pdf.js of its own.
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

/**
 * A copy of the caller's bytes that pdf.js is free to destroy.
 *
 * pdf.js **transfers** the buffer to its worker thread, which detaches it in this one.
 * Anything the caller still holds becomes unusable — v1 read a PDF, extracted it, then tried
 * to write the same bytes into the vault and got "Cannot perform Construct on a detached
 * ArrayBuffer".
 *
 * Neither obvious shorthand is safe:
 *
 *   `new Uint8Array(x)`  copies a typed array but only *views* an ArrayBuffer — which is how
 *                        the caller's own memory reached the worker in the first place.
 *   `x.slice()`          gives fresh memory for a Uint8Array, but `Buffer.prototype.slice` is
 *                        an alias of `subarray`: another Buffer over the same memory. pdf.js
 *                        rejects a Buffer outright anyway.
 *
 * Written longhand, this yields a plain Uint8Array owning fresh memory whatever went in.
 */
export function privateCopy(data: ArrayBuffer | Uint8Array): Uint8Array {
	const view = data instanceof Uint8Array ? data : new Uint8Array(data);
	const bytes = new Uint8Array(view.byteLength);
	bytes.set(view);
	return bytes;
}
