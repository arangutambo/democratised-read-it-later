/**
 * A PDF as a sequence of surfaces you can point at.
 *
 * Owns the pdf.js document and every canvas made from it. The rules that keep this from
 * leaking are in `reader/pdfjs.ts`; what is added here is lifecycle: a render in flight when
 * you scroll past must be cancelled, and closing the document must destroy the loading task
 * rather than the document proxy.
 *
 * The geometry lives in `gesture/region.ts` and is tested without a canvas, because a clip
 * that is off by a scale factor produces a perfectly valid PNG of the wrong thing.
 */

import { planRegionRender, WHOLE_SURFACE } from "../gesture/region";
import {
	obsidianPdfJs,
	privateCopy,
	type PdfDocument,
	type PdfJsLib,
	type PdfLoadingTask,
	type PdfPage,
} from "../pdfjs";
import type { NormalisedRect } from "../../capture/types";
import type { DocumentSurfaces, SurfaceSize } from "./surface";

export interface PageSizePoints {
	width: number;
	height: number;
}

/** A positioned run of text, for the selectable layer over a rendered page. */
export interface TextSpan {
	text: string;
	/** Normalised within the page, so the layer can be positioned at any zoom. */
	left: number;
	top: number;
	height: number;
}

export interface RenderedPage {
	canvas: HTMLCanvasElement;
	/** CSS pixels the canvas should occupy. Distinct from its backing-store size. */
	cssWidth: number;
	cssHeight: number;
}

export interface OpenOptions {
	/** Defaults to Obsidian's bundled copy. Injected in tests. */
	pdfjs?: PdfJsLib;
	/** Defaults to `document.createElement`. Injected so geometry can be exercised headless. */
	createCanvas?: () => HTMLCanvasElement;
}

export class PdfSurface implements DocumentSurfaces {
	readonly kind = "pdf-page" as const;
	/** A PDF page is a real, bounded thing, so key 3 means something here. */
	readonly wholeSurfaceIsClippable = true;

	private readonly task: PdfLoadingTask;
	private readonly document: PdfDocument;
	private readonly createCanvas: () => HTMLCanvasElement;
	/** Cached page proxies. pdf.js caches internally too, but `cleanup()` is ours to call. */
	private readonly pages = new Map<number, PdfPage>();
	private closed = false;

	private constructor(
		task: PdfLoadingTask,
		document: PdfDocument,
		createCanvas: () => HTMLCanvasElement,
	) {
		this.task = task;
		this.document = document;
		this.createCanvas = createCanvas;
	}

	static async open(data: ArrayBuffer | Uint8Array, options: OpenOptions = {}): Promise<PdfSurface> {
		const pdfjs = options.pdfjs ?? (await obsidianPdfJs());
		const createCanvas = options.createCanvas ?? (() => document.createElement("canvas"));

		// `isEvalSupported: false` keeps pdf.js from compiling font programs with eval, which a
		// stricter Obsidian content-security policy would refuse anyway.
		const task = pdfjs.getDocument({ data: privateCopy(data), isEvalSupported: false });

		try {
			const doc = await task.promise;
			return new PdfSurface(task, doc, createCanvas);
		} catch (error) {
			// A failed open still leaves a task holding a worker transport.
			await task.destroy().catch(() => {});
			throw error;
		}
	}

	get pageCount(): number {
		return this.document.numPages;
	}

	/** `DocumentSurfaces.count`. Pages are the surfaces of a PDF. */
	get count(): number {
		return this.document.numPages;
	}

	private async page(number: number): Promise<PdfPage> {
		const clamped = Math.min(this.pageCount, Math.max(1, Math.floor(number)));
		const cached = this.pages.get(clamped);
		if (cached) return cached;

		const page = await this.document.getPage(clamped);
		this.pages.set(clamped, page);
		return page;
	}

	async pageSize(number: number): Promise<PageSizePoints> {
		const viewport = (await this.page(number)).getViewport({ scale: 1 });
		return { width: viewport.width, height: viewport.height };
	}

	/** `DocumentSurfaces.size`. PDF sizes are in points. */
	size(index: number): Promise<SurfaceSize> {
		return this.pageSize(index);
	}

	/**
	 * Render a page for display at `cssWidth`, backed at the device's pixel ratio.
	 *
	 * Display rendering is deliberately not the clip resolution: showing a page at 800 CSS px
	 * needs 1600 device px on a 2× screen, not the 1240 that a 150 DPI clip wants. Rendering
	 * display pages at clip resolution would multiply the memory budget for no visible gain.
	 */
	async renderPage(
		number: number,
		cssWidth: number,
		devicePixelRatio = 1,
		signal?: AbortSignal,
	): Promise<RenderedPage> {
		const page = await this.page(number);
		const unit = page.getViewport({ scale: 1 });

		const scale = (cssWidth / unit.width) * Math.max(1, devicePixelRatio);
		const viewport = page.getViewport({ scale });

		const canvas = this.createCanvas();
		canvas.width = Math.max(1, Math.round(viewport.width));
		canvas.height = Math.max(1, Math.round(viewport.height));

		const context = canvas.getContext("2d");
		if (!context) throw new Error("Could not get a 2D context for the page canvas.");

		const task = page.render({ canvasContext: context, viewport });

		// Scrolling fast starts more renders than it finishes; an abandoned one still costs
		// worker time and still writes into a canvas nobody will show.
		const onAbort = () => task.cancel();
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await task.promise;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		return {
			canvas,
			cssWidth,
			cssHeight: cssWidth * (unit.height / unit.width),
		};
	}

	/**
	 * Render a normalised region of a page to PNG bytes at `dpi`.
	 *
	 * The whole page is rendered at the target scale and the region cropped out, because
	 * pdf.js has no "render this rectangle" call and offsetting the transform by hand is how
	 * clips end up subtly shifted.
	 */
	async renderRegion(
		number: number,
		rect: NormalisedRect,
		dpi: number,
		signal?: AbortSignal,
	): Promise<Uint8Array> {
		const page = await this.page(number);
		const unit = page.getViewport({ scale: 1 });
		const plan = planRegionRender(rect, { width: unit.width, height: unit.height }, dpi);

		const viewport = page.getViewport({ scale: plan.scale });

		const full = this.createCanvas();
		const crop = this.createCanvas();

		/*
		 * Both canvases are large and short-lived, and the release is in a `finally` because
		 * the failure path is the one that matters: a cancelled render throws, and a clip
		 * abandoned mid-drag would otherwise strand a full-page backing store every time.
		 *
		 * Zeroing the dimensions is what actually frees it in Chromium — dropping the
		 * reference leaves it to the garbage collector's discretion, which on a burst of
		 * clips is far too late.
		 */
		try {
			full.width = Math.max(1, Math.round(viewport.width));
			full.height = Math.max(1, Math.round(viewport.height));

			const context = full.getContext("2d");
			if (!context) throw new Error("Could not get a 2D context for the clip canvas.");

			const task = page.render({ canvasContext: context, viewport });
			const onAbort = () => task.cancel();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await task.promise;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}

			crop.width = plan.width;
			crop.height = plan.height;

			const cropContext = crop.getContext("2d");
			if (!cropContext) throw new Error("Could not get a 2D context for the crop canvas.");
			cropContext.drawImage(
				full,
				plan.crop.x,
				plan.crop.y,
				plan.width,
				plan.height,
				0,
				0,
				plan.width,
				plan.height,
			);

			return await canvasToPng(crop);
		} finally {
			release(full);
			release(crop);
		}
	}

	/** The whole page, as a clip. Key 3. */
	async renderWholePage(number: number, dpi: number, signal?: AbortSignal): Promise<Uint8Array> {
		return this.renderRegion(number, WHOLE_SURFACE, dpi, signal);
	}

	/** Positioned text for the selectable layer over a rendered page. */
	async textLayer(number: number): Promise<TextSpan[]> {
		const page = await this.page(number);
		const unit = page.getViewport({ scale: 1 });
		const content = await page.getTextContent();

		const spans: TextSpan[] = [];
		for (const item of content.items) {
			const text = item.str;
			if (typeof text !== "string" || text === "") continue;
			const transform = item.transform;
			if (!Array.isArray(transform) || transform.length < 6) continue;

			const height = item.height && item.height > 0 ? item.height : Math.abs(transform[3]);

			spans.push({
				text,
				left: transform[4] / unit.width,
				// PDF y runs up from the bottom; the DOM runs down from the top.
				top: (unit.height - transform[5] - height) / unit.height,
				height: height / unit.height,
			});
		}
		return spans;
	}

	/**
	 * Destroying the **loading task** tears down the document and its worker transport with
	 * it. `PDFDocumentProxy.destroy()` was removed by pdf.js v6.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;

		for (const page of this.pages.values()) page.cleanup?.();
		this.pages.clear();

		await this.task.destroy().catch(() => {});
	}
}

function release(canvas: HTMLCanvasElement): void {
	canvas.width = 0;
	canvas.height = 0;
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("The clip could not be encoded as a PNG.");
	return new Uint8Array(await blob.arrayBuffer());
}
