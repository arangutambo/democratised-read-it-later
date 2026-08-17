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
	type PdfOutlineNode,
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
	/**
	 * Normalised width of the run as the PDF lays it out.
	 *
	 * Load-bearing for selection. Our span is rendered in a completely different font from the
	 * one embedded in the PDF, so its natural width is wrong — sometimes by a lot. The layer
	 * scales each span horizontally to this width, which is what makes the invisible selection
	 * boxes sit over the glyphs you can actually see. Without it, selection boundaries drift
	 * further from the text the further along a line you drag.
	 */
	width: number;
}

/** A table-of-contents entry: what it says, how deep it sits, and where it goes. */
export interface OutlineEntry {
	title: string;
	depth: number;
	page?: number;
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
	/** Page text, kept for search. Dropped with the document. */
	private readonly textCache = new Map<number, string>();
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

	/**
	 * A page's text as one string, cached.
	 *
	 * Search asks for every page in turn, and a second search of the same document must not
	 * re-extract anything — each call is a worker round trip, and a 315-page workbook is 315
	 * of them. The cache is dropped with the document.
	 */
	async pageText(number: number): Promise<string> {
		const clamped = Math.min(this.pageCount, Math.max(1, Math.floor(number)));
		const cached = this.textCache.get(clamped);
		if (cached !== undefined) return cached;

		const spans = await this.textLayer(clamped);
		const text = spans.map((span) => span.text).join(" ").replace(/\s+/g, " ").trim();
		this.textCache.set(clamped, text);
		return text;
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
			// Some generators report no width; the horizontal scale times the run length is a
			// serviceable estimate, and a wrong-but-close width beats a zero one.
			const width = item.width && item.width > 0 ? item.width : Math.abs(transform[0]) * text.length * 0.5;

			spans.push({
				text,
				left: transform[4] / unit.width,
				// PDF y runs up from the bottom; the DOM runs down from the top.
				top: (unit.height - transform[5] - height) / unit.height,
				height: height / unit.height,
				width: width / unit.width,
			});
		}
		/*
		 * Reading order, not content-stream order.
		 *
		 * The layer is absolutely positioned, so DOM order is whatever order the PDF happened
		 * to draw its text boxes in. Sorting here means a browser selection between two
		 * visually adjacent runs covers what is actually between them on the page.
		 */
		return spans.sort((a, b) => {
			const centreA = a.top + a.height / 2;
			const centreB = b.top + b.height / 2;
			if (Math.abs(centreA - centreB) > 0.006) return centreA - centreB;
			return a.left - b.left;
		});
	}

	/**
	 * The document's own table of contents, flattened to titles and page numbers.
	 *
	 * Empty for most slide decks, which carry none — the caller shows nothing rather than an
	 * empty panel. Resolving a destination to a page costs a round trip each, so this is done
	 * once and cached by the caller.
	 */
	async outline(): Promise<OutlineEntry[]> {
		if (typeof this.document.getOutline !== "function") return [];

		const nodes = await this.document.getOutline().catch(() => null);
		if (!nodes || nodes.length === 0) return [];

		const out: OutlineEntry[] = [];
		const walk = async (items: PdfOutlineNode[], depth: number): Promise<void> => {
			for (const item of items) {
				const title = typeof item.title === "string" ? item.title.trim() : "";
				if (title !== "") {
					out.push({ title, depth, page: await this.pageOf(item.dest) });
				}
				if (Array.isArray(item.items) && item.items.length > 0) {
					await walk(item.items, depth + 1);
				}
			}
		};

		await walk(nodes, 0);
		return out;
	}

	/** The page a destination points at, or undefined when it cannot be resolved. */
	private async pageOf(dest: PdfOutlineNode["dest"]): Promise<number | undefined> {
		try {
			const explicit =
				typeof dest === "string" ? await this.document.getDestination?.(dest) : dest;
			if (!Array.isArray(explicit) || explicit.length === 0) return undefined;

			const index = await this.document.getPageIndex?.(explicit[0]);
			// pdf.js counts from zero; everything else here counts from one.
			return typeof index === "number" ? index + 1 : undefined;
		} catch {
			// A broken destination costs one outline entry its link, never the outline.
			return undefined;
		}
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
		this.textCache.clear();

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
