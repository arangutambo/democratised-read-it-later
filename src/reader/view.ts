/**
 * The Reader view: a document on the left, your note on the right.
 *
 * `TextFileView` is the base because a `.reader` file *is* text — JSON — and that gives file
 * loading, debounced saving and external-change handling without writing any of it. What is
 * added here is the page pipeline, the three keys, and teardown.
 *
 * Teardown is treated as a feature. This vault has a documented history of blank screens and
 * 100% CPU from plugin JS that kept running after unload, and a custom always-open view with
 * a render loop is exactly that risk. Every observer, listener, canvas and pdf.js document
 * registers for disposal, and the view is written so that closing it releases everything even
 * mid-render.
 */

import { Notice, Platform, TFile, TextFileView, type WorkspaceLeaf } from "obsidian";

import { makeClip, unmappableRatio, UNMAPPABLE_LIMIT } from "../capture/capture";
import type { CaptureRequest, NormalisedRect } from "../capture/types";
import { Logger } from "../core/log";
import { appendClip } from "../note/append";
import { positionOf } from "../note/bullet";
import { captureSelection } from "./gesture/selection";
import { boxBetween, toNormalised, WHOLE_SURFACE } from "./gesture/region";
import {
	createPageElement,
	releaseCanvas,
	setCanvas,
	setMarks,
	setTextLayer,
	type PageElement,
} from "./render/page-element";
import { PageWindow } from "./render/virtualiser";
import { PdfSurface } from "./surface/pdf";
import {
	createDocument,
	parseDocument,
	reconcile,
	serialise,
	type ReaderDocument,
} from "./document";

export const READER_VIEW_TYPE = "reader-document";

export interface ReaderViewDeps {
	clipDpi: number;
	assetsFolder: string;
	/** Pages held as canvases at once. Lower on mobile, where memory is the binding limit. */
	pageBudget: number;
	log: Logger;
}

type Mode = "read" | "arming-region";

export class ReaderView extends TextFileView {
	private readonly deps: ReaderViewDeps;

	private doc?: ReaderDocument;
	private surface?: PdfSurface;
	private window?: PageWindow;

	private scroller!: HTMLElement;
	private statusEl!: HTMLElement;

	private readonly pages = new Map<number, PageElement>();
	private observer?: IntersectionObserver;
	private renderAbort?: AbortController;

	private mode: Mode = "read";
	/** Removes the document-level Escape listener while a region is armed. */
	private escapeHandler?: () => void;
	/** Guards against a second load starting while the first is still opening a document. */
	private loadToken = 0;

	constructor(leaf: WorkspaceLeaf, deps: ReaderViewDeps) {
		super(leaf);
		this.deps = deps;
	}

	getViewType(): string {
		return READER_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return this.file?.basename ?? "Reader";
	}

	override getIcon(): string {
		return "book-open";
	}

	// ---------------------------------------------------------------- TextFileView contract

	getViewData(): string {
		return this.doc ? serialise(this.doc) : this.data;
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.clear();
		this.data = data;
		void this.openDocument(data);
	}

	clear(): void {
		this.loadToken++;
		this.renderAbort?.abort();
		this.renderAbort = undefined;

		this.observer?.disconnect();
		this.observer = undefined;

		for (const page of this.pages.values()) releaseCanvas(page);
		this.pages.clear();
		this.window = undefined;

		const surface = this.surface;
		this.surface = undefined;
		void surface?.close();

		this.doc = undefined;
		this.scroller?.replaceChildren();
	}

	// ------------------------------------------------------------------------- lifecycle

	protected override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("reader-view");

		this.scroller = root.createDiv({ cls: "reader-scroller" });
		this.statusEl = root.createDiv({ cls: "reader-status" });

		// `registerDomEvent` is Obsidian's own lifecycle-managed registration; the listener is
		// removed when the view unloads without any bookkeeping here.
		this.registerDomEvent(root, "keydown", (event) => this.onKeyDown(event));
		this.registerDomEvent(this.scroller, "mousedown", (event) => this.onMouseDown(event));

		// Focusable, so the three keys have somewhere to land.
		root.tabIndex = -1;

		/*
		 * Re-render when the pane is resized.
		 *
		 * Canvases are rasterised at a fixed pixel width, so dragging the split wider left the
		 * pages stretched and soft — and, worse, the text layer stopped lining up with them,
		 * which made selection miss. CSS alone cannot fix that; the page has to be redrawn.
		 *
		 * Debounced hard, because a drag fires this continuously and each re-render is real
		 * pdf.js work.
		 */
		let pending: number | undefined;
		let lastWidth = 0;
		const observer = new ResizeObserver((entries) => {
			const width = Math.round(entries[0]?.contentRect.width ?? 0);
			// Height changes alone do not affect rasterisation.
			if (width === lastWidth || width === 0) return;
			lastWidth = width;

			window.clearTimeout(pending);
			pending = window.setTimeout(() => void this.rerenderVisible(), 250);
		});
		observer.observe(this.scroller);

		this.register(() => {
			observer.disconnect();
			window.clearTimeout(pending);
		});
	}

	/** Redraw the pages currently held, at the new width. */
	private async rerenderVisible(): Promise<void> {
		const held = this.window?.held ?? [];
		if (held.length === 0) return;

		this.renderAbort?.abort();
		const controller = new AbortController();
		this.renderAbort = controller;

		for (const page of held) {
			if (controller.signal.aborted) return;
			await this.renderOne(page, controller.signal);
		}
	}

	protected override async onClose(): Promise<void> {
		this.clear();
		this.contentEl.empty();
	}

	// ------------------------------------------------------------------------- loading

	private async openDocument(data: string): Promise<void> {
		const token = ++this.loadToken;

		try {
			const { document, warnings } = parseDocument(data);
			for (const warning of warnings) this.deps.log.warn(`${this.file?.path}: ${warning}`);

			const bytes = await this.readSource(document.source.path);
			if (token !== this.loadToken) return;

			const surface = await PdfSurface.open(bytes);
			if (token !== this.loadToken) {
				// The view moved on while pdf.js was starting; this document is already stale.
				await surface.close();
				return;
			}

			this.surface = surface;
			// Assigned *before* reconciling. `getViewData()` falls back to `this.data` — the raw
			// text as loaded — when there is no document, so a save landing in that window wrote
			// the un-reconciled file straight back and every dropped mark returned.
			this.doc = document;
			this.doc = await this.reconcileWithNote(document);
			this.window = new PageWindow({ total: surface.pageCount, budget: this.deps.pageBudget });

			await this.buildPages();
			this.watchNote();
			this.setStatus(`${surface.pageCount} pages · q quote · r region · p page`);
		} catch (error) {
			this.deps.log.error("could not open the document", error);
			const message = error instanceof Error ? error.message : "Could not open this document.";
			this.scroller.empty();
			this.scroller.createDiv({ cls: "reader-error", text: message });
			this.setStatus("");
		}
	}

	/** Vault-relative or absolute. Reader renders PDFs itself, so either can be read. */
	private async readSource(path: string): Promise<Uint8Array> {
		const inVault = this.app.vault.getAbstractFileByPath(path);
		if (inVault instanceof TFile) {
			return new Uint8Array(await this.app.vault.readBinary(inVault));
		}

		if (!Platform.isDesktopApp) {
			throw new Error(
				`${path} is not in the vault, and files outside the vault can only be opened on desktop.`,
			);
		}

		// Lazily import the *local* module holding the static node builtin import. See
		// external-file.ts for why the builtin itself is never imported dynamically.
		const { readExternalFile } = await import("./external-file");
		return readExternalFile(path);
	}

	/**
	 * The note is authoritative for what exists. See `document.ts` — deleting a bullet drops
	 * its mark, permanently.
	 */
	private async reconcileWithNote(document: ReaderDocument): Promise<ReaderDocument> {
		const note = this.app.vault.getAbstractFileByPath(document.notePath);
		if (!(note instanceof TFile)) return document;

		const result = reconcile(document, await this.app.vault.read(note));
		if (result.changed) {
			this.deps.log.info(`dropped ${result.dropped.length} mark(s) deleted from the note`);
			// Persist through TextFileView's own debounced save.
			this.requestSave();
		}
		return result.document;
	}

	/**
	 * Reconcile whenever the note changes, not only when the document is opened.
	 *
	 * Deleting a bullet with the reader open left its mark on the page — and worse, the next
	 * debounced save wrote the still-in-memory clip list back, so the mark survived a reopen
	 * too. Watching the note makes deletion take effect where you can see it.
	 *
	 * Debounced: Obsidian fires `modify` on every keystroke once its own save settles, and
	 * re-reading the note on each one would be a read per character typed.
	 */
	private watchNote(): void {
		let pending: number | undefined;

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path !== this.doc?.notePath) return;

				window.clearTimeout(pending);
				pending = window.setTimeout(() => void this.reconcileNow(), 600);
			}),
		);

		// The timer is the one thing Obsidian does not own here.
		this.register(() => window.clearTimeout(pending));
	}

	private async reconcileNow(): Promise<void> {
		const doc = this.doc;
		if (!doc) return;

		const note = this.app.vault.getAbstractFileByPath(doc.notePath);
		if (!(note instanceof TFile)) return;

		const result = reconcile(doc, await this.app.vault.read(note));
		if (!result.changed) return;

		this.doc = result.document;
		this.requestSave();

		// Redraw only the pages that lost something.
		for (const id of result.dropped) {
			const page = doc.clips[id]?.surface.index;
			if (page !== undefined) this.drawMarks(page);
		}
		this.deps.log.info(`dropped ${result.dropped.length} mark(s) deleted from the note`);
	}

	// ------------------------------------------------------------------------- rendering

	private async buildPages(): Promise<void> {
		const surface = this.surface;
		if (!surface) return;

		this.scroller.empty();
		this.pages.clear();

		// One page's aspect ratio stands in for all of them, so the scrollbar is right
		// immediately. Asking pdf.js for 315 page sizes up front costs seconds.
		const first = await surface.size(1);
		const ratio = first.height / first.width;

		const observer = new IntersectionObserver((entries) => this.onVisible(entries), {
			root: this.scroller,
			// Fires while a page is still approaching, so its render has a head start.
			rootMargin: "200px 0px",
			threshold: 0.01,
		});
		this.observer = observer;
		// Belt and braces: Obsidian tears the view down, and this guarantees the observer
		// stops even if that path changes.
		this.register(() => observer.disconnect());

		for (let n = 1; n <= surface.pageCount; n++) {
			const page = createPageElement(n);
			page.root.style.aspectRatio = `1 / ${ratio}`;
			this.pages.set(n, page);
			this.scroller.append(page.root);
			observer.observe(page.root);
		}
	}

	private onVisible(entries: IntersectionObserverEntry[]): void {
		const visible = entries
			.filter((entry) => entry.isIntersecting)
			.map((entry) => Number((entry.target as HTMLElement).dataset.page))
			.filter((n) => Number.isFinite(n));

		if (visible.length === 0) return;

		// The topmost visible page is the one you are reading.
		const current = Math.min(...visible);
		void this.goTo(current);
	}

	private async goTo(pageNumber: number): Promise<void> {
		const window = this.window;
		const surface = this.surface;
		if (!window || !surface || !this.doc) return;

		const change = window.update(pageNumber);
		if (change.render.length === 0 && change.release.length === 0) return;

		for (const n of change.release) {
			const page = this.pages.get(n);
			if (page) releaseCanvas(page);
		}

		this.doc.view.surface = pageNumber;
		this.requestSave();

		// One controller for the whole batch: scrolling on abandons all of it at once.
		this.renderAbort?.abort();
		const controller = new AbortController();
		this.renderAbort = controller;

		for (const n of change.render) {
			if (controller.signal.aborted) return;
			await this.renderOne(n, controller.signal);
		}
	}

	private async renderOne(pageNumber: number, signal: AbortSignal): Promise<void> {
		const surface = this.surface;
		const page = this.pages.get(pageNumber);
		if (!surface || !page) return;

		try {
			const cssWidth = Math.max(200, this.scroller.clientWidth - 32);
			const rendered = await surface.renderPage(
				pageNumber,
				cssWidth,
				window.devicePixelRatio || 1,
				signal,
			);
			if (signal.aborted) {
				rendered.canvas.width = 0;
				rendered.canvas.height = 0;
				return;
			}

			setCanvas(page, rendered.canvas, rendered.cssWidth, rendered.cssHeight);
			setTextLayer(page, await surface.textLayer(pageNumber), rendered.cssWidth, rendered.cssHeight);
			this.drawMarks(pageNumber);
		} catch (error) {
			// A cancelled render is the normal outcome of scrolling, not a fault.
			if (signal.aborted) return;
			this.deps.log.warn(`page ${pageNumber} did not render`, error);
		}
	}

	private drawMarks(pageNumber: number): void {
		const page = this.pages.get(pageNumber);
		if (!page || !this.doc) return;

		const rects: NormalisedRect[] = [];
		for (const locator of Object.values(this.doc.clips)) {
			if (locator.surface.index === pageNumber && locator.rect) rects.push(locator.rect);
		}
		setMarks(page, rects);
	}

	// ------------------------------------------------------------------------- gestures

	private onKeyDown(event: KeyboardEvent): void {
		// Never steal a key from a text field, and never fight a modifier chord.
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		switch (event.key.toLowerCase()) {
			case "q":
				event.preventDefault();
				void this.clipSelection();
				break;
			case "r":
				event.preventDefault();
				this.armRegion();
				break;
			case "p":
				event.preventDefault();
				void this.clipWholePage();
				break;
			// Escape is handled on the document while armed — see armRegion().
		}
	}

	private armRegion(): void {
		this.mode = "arming-region";
		this.scroller.addClass("is-arming-region");
		this.setStatus("Drag a box around what you want. Escape to cancel.");

		/*
		 * Escape has to be caught on the document, not on the view.
		 *
		 * The view's own keydown handler only fires while the view holds focus, and arming the
		 * mode is exactly when focus tends to be somewhere else — you pressed `r`, moved the
		 * mouse, and the click that would have focused the view is the one you are trying to
		 * avoid making. Capturing on the document means Escape always gets out.
		 */
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			this.disarmRegion();
		};

		document.addEventListener("keydown", onEscape, { capture: true });
		this.escapeHandler = () => document.removeEventListener("keydown", onEscape, { capture: true });
		this.register(this.escapeHandler);
	}

	private disarmRegion(): void {
		this.mode = "read";
		this.escapeHandler?.();
		this.escapeHandler = undefined;
		this.scroller.removeClass("is-arming-region");
		this.setStatus(`${this.surface?.pageCount ?? 0} pages · q quote · r region · p page`);
	}

	private onMouseDown(event: MouseEvent): void {
		if (this.mode !== "arming-region" || event.button !== 0) return;

		const pageEl = (event.target as HTMLElement).closest(".reader-page") as HTMLElement | null;
		const pageNumber = Number(pageEl?.dataset.page);
		if (!pageEl || !Number.isFinite(pageNumber)) return;

		event.preventDefault();

		const origin = { x: event.clientX, y: event.clientY };
		const marquee = pageEl.createDiv({ cls: "reader-marquee" });

		const pageRect = () => pageEl.getBoundingClientRect();

		const onMove = (move: MouseEvent) => {
			const rect = pageRect();
			const box = boxBetween(origin, { x: move.clientX, y: move.clientY });
			marquee.style.left = `${box.x - rect.left}px`;
			marquee.style.top = `${box.y - rect.top}px`;
			marquee.style.width = `${box.width}px`;
			marquee.style.height = `${box.height}px`;
		};

		const onUp = (up: MouseEvent) => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			marquee.remove();

			const rect = pageRect();
			const box = boxBetween(origin, { x: up.clientX, y: up.clientY });
			const normalised = toNormalised(
				{ x: box.x - rect.left, y: box.y - rect.top, width: box.width, height: box.height },
				rect.width,
				rect.height,
			);

			this.disarmRegion();
			void this.clipRegion(pageNumber, normalised);
		};

		// Listeners live on the document so a drag that leaves the page still completes, and
		// both are removed in `onUp` whatever happens.
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}

	// ------------------------------------------------------------------------- clipping

	private async clipSelection(): Promise<void> {
		const doc = this.doc;
		if (!doc) return;

		const selection = activeWindow.getSelection();
		const pageEl = selection?.anchorNode
			? ((selection.anchorNode as Node).parentElement?.closest(".reader-page") as HTMLElement | null)
			: null;
		const pageNumber = Number(pageEl?.dataset.page);

		if (!pageEl || !Number.isFinite(pageNumber)) {
			new Notice("Reader: select some text on a page first.");
			return;
		}

		const page = this.pages.get(pageNumber);
		const captured = captureSelection(selection, pageEl, page?.text ?? "", page?.spans ?? []);
		if (!captured) {
			new Notice("Reader: nothing is selected.");
			return;
		}

		/*
		 * Displayed maths does not survive text extraction — the stretchy brackets of a column
		 * vector and the big operators are Computer Modern glyphs with no Unicode meaning, so a
		 * quote of one arrives as `v =⃝⃝⃝⃝⃝v1v2...vn⃝⃝⃝⃝⃝`. Nothing recovers those characters;
		 * they are not in the file. Say so, and point at the gesture that does work.
		 */
		if (unmappableRatio(captured.text) > UNMAPPABLE_LIMIT) {
			new Notice(
				"Reader: that selection is mostly typeset maths, which a PDF stores as shapes " +
					"rather than characters — quoting it would write nonsense. Press r and drag a " +
					"box around it instead.",
				12_000,
			);
			return;
		}

		await this.commit({
			kind: "quote",
			text: captured.text,
			locator: {
				surface: { kind: "pdf-page", index: pageNumber },
				rect: captured.rect,
				quote: captured.quote,
			},
		});

		selection?.removeAllRanges();
	}

	private async clipRegion(pageNumber: number, rect: NormalisedRect): Promise<void> {
		await this.commitImage(pageNumber, rect);
	}

	private async clipWholePage(): Promise<void> {
		const current = this.doc?.view.surface ?? 1;
		await this.commitImage(current, WHOLE_SURFACE);
	}

	private async commitImage(pageNumber: number, rect: NormalisedRect): Promise<void> {
		const surface = this.surface;
		if (!surface) return;

		try {
			const png = await surface.renderRegion(pageNumber, rect, this.deps.clipDpi);
			await this.commit({
				kind: "image",
				png,
				locator: { surface: { kind: "pdf-page", index: pageNumber }, rect },
			});
		} catch (error) {
			this.deps.log.error("could not render the clip", error);
			new Notice("Reader: that clip could not be rendered — check the console.");
		}
	}

	/**
	 * Write the clip: asset first, then the bullet, then the mark.
	 *
	 * The order matters. If the asset write fails there is no bullet pointing at a file that
	 * does not exist, and if the note write fails there is an orphaned PNG — which the sweep
	 * command cleans up, and which is a far better failure than a broken embed.
	 */
	private async commit(request: CaptureRequest): Promise<void> {
		const doc = this.doc;
		const file = this.file;
		if (!doc || !file) return;

		try {
			let assetPath: string | undefined;
			if (request.kind === "image" && request.png) {
				assetPath = await this.writeAsset(file.basename, request.locator.surface.index, request.png);
			}

			const clip = makeClip(request, { documentId: file.path }, assetPath);

			// Page order, not capture order: you clip a figure on page 12 and then go back for
			// the definition on page 3, and the note should still read straight through.
			const position = await appendClip(this.app, doc.notePath, clip, {
				positionAt: (blockId) => {
					for (const [id, locator] of Object.entries(doc.clips)) {
						if (id.toLowerCase() === blockId) return positionOf(locator);
					}
					return undefined;
				},
			});

			doc.clips[clip.id] = clip.locator;
			this.requestSave();
			this.drawMarks(request.locator.surface.index);

			await this.revealNote(position);
		} catch (error) {
			this.deps.log.error("could not save the clip", error);
			const message = error instanceof Error ? error.message : "The clip could not be saved.";
			new Notice(`Reader: ${message}`, 10_000);
		}
	}

	private async writeAsset(basename: string, pageNumber: number, png: Uint8Array): Promise<string> {
		const folder = `${this.deps.assetsFolder}/${sanitise(basename)}`;
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {
				// Concurrent clips race here; an existing folder is the outcome either way.
			});
		}

		const stamp = Date.now().toString(36);
		const path = `${folder}/p${pageNumber}-${stamp}.png`;
		await this.app.vault.createBinary(path, toArrayBuffer(png));
		return path;
	}

	/**
	 * Put the cursor where the writing goes.
	 *
	 * A clip that lands somewhere off-screen is a gesture that stops halfway — the whole point
	 * is to type underneath it. The note is opened in a split beside the document if it is not
	 * already showing.
	 */
	private async revealNote(position: { line: number; ch: number }): Promise<void> {
		const doc = this.doc;
		if (!doc) return;

		const note = this.app.vault.getAbstractFileByPath(doc.notePath);
		if (!(note instanceof TFile)) return;

		const existing = this.app.workspace
			.getLeavesOfType("markdown")
			.find((leaf) => (leaf.view as { file?: TFile }).file?.path === note.path);

		const leaf = existing ?? this.app.workspace.getLeaf("split", "vertical");
		if (!existing) await leaf.openFile(note);

		const view = leaf.view as { editor?: { setCursor(pos: { line: number; ch: number }): void; focus(): void } };
		const editor = view.editor;
		if (!editor) return;

		// `position` is the writing line under the clip that just landed — which is no longer
		// the end of the note now that clips sort by page.
		editor.setCursor(position);
		editor.focus();
	}

	private setStatus(text: string): void {
		if (this.statusEl) this.statusEl.setText(text);
	}
}

/** Vault paths reject these outright, and a colon silently breaks on Windows. */
function sanitise(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "document";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

export { createDocument };
