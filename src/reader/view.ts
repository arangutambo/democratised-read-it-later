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
import type { CaptureRequest, Clip, NormalisedRect } from "../capture/types";
import { Logger } from "../core/log";
import { appendClip } from "../note/append";
import { positionOf } from "../note/bullet";
import { sectionsForPage, type Section } from "../note/headings";
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
import { EpubSurface } from "../epub/surface";
import { PdfSurface, type OutlineEntry } from "./surface/pdf";
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
	/** Reports the page count once known, so the library can show progress as a fraction. */
	onPageCount?: (readerPath: string, pages: number) => void;
	log: Logger;
}

type Mode = "read" | "arming-region";

export class ReaderView extends TextFileView {
	private readonly deps: ReaderViewDeps;

	private doc?: ReaderDocument;
	/**
	 * The open document.
	 *
	 * Two shapes, and the difference runs deeper than rendering: a PDF page is pixels with an
	 * invisible text layer over it, an EPUB section is already a DOM. So selection, structure
	 * and figure clips all take a different route, and the branches are explicit rather than
	 * hidden behind an abstraction that would have to lie about one of them.
	 */
	private surface?: PdfSurface;
	private epub?: EpubSurface;
	/** Releases the object URLs of sections currently rendered. */
	private readonly sectionReleases = new Map<number, () => void>();
	private window?: PageWindow;

	private scroller!: HTMLElement;
	private outlineEl!: HTMLElement;
	/** The document's table of contents, resolved once on open. */
	private outline: OutlineEntry[] = [];

	private searchEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private searchStatusEl!: HTMLElement;
	private searchResultsEl!: HTMLElement;
	private searchAbort?: AbortController;

	/** Display scale. 1 fills the pane; larger zooms in and the column scrolls sideways. */
	private zoom = 1;
	private statusEl!: HTMLElement;

	private readonly pages = new Map<number, PageElement>();
	private observer?: IntersectionObserver;
	private renderAbort?: AbortController;

	private mode: Mode = "read";
	/** Whether the armed region will become a parent. */
	private pendingParent = false;
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

		for (const release of this.sectionReleases.values()) release();
		this.sectionReleases.clear();

		const surface = this.surface;
		this.surface = undefined;
		void surface?.close();

		const epub = this.epub;
		this.epub = undefined;
		void epub?.close();

		this.doc = undefined;
		this.scroller?.replaceChildren();
	}

	// ------------------------------------------------------------------------- lifecycle

	protected override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("reader-view");

		this.searchEl = root.createDiv({ cls: "reader-search is-hidden" });
		this.searchInput = this.searchEl.createEl("input", {
			type: "search",
			placeholder: "Find in document…",
		});
		this.searchStatusEl = this.searchEl.createDiv({ cls: "reader-search-status" });
		this.searchResultsEl = this.searchEl.createDiv({ cls: "reader-search-results" });

		// Debounced: a keystroke abandons the previous sweep rather than racing it.
		let pendingSearch: number | undefined;
		this.registerDomEvent(this.searchInput, "input", () => {
			window.clearTimeout(pendingSearch);
			pendingSearch = window.setTimeout(() => void this.runSearch(this.searchInput.value), 250);
		});
		this.registerDomEvent(this.searchInput, "keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.toggleSearch(false);
			}
			// The three keys must not fire while you are typing a query.
			event.stopPropagation();
		});
		this.register(() => {
			window.clearTimeout(pendingSearch);
			this.searchAbort?.abort();
		});

		const body = root.createDiv({ cls: "reader-body" });
		this.outlineEl = body.createDiv({ cls: "reader-outline" });
		this.scroller = body.createDiv({ cls: "reader-scroller" });
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

	/**
	 * Show or hide the find bar.
	 *
	 * Focus goes to the input on open, because the whole point of a key is not reaching for
	 * the mouse afterwards.
	 */
	private toggleSearch(show: boolean): void {
		this.searchEl.toggleClass("is-hidden", !show);
		if (show) {
			this.searchInput.focus();
			this.searchInput.select();
		} else {
			this.searchAbort?.abort();
			this.contentEl.focus();
		}
	}

	/** Sweep the document, showing results as they arrive. */
	private async runSearch(query: string): Promise<void> {
		const surface = this.surface;
		if (!surface) return;

		this.searchAbort?.abort();
		const controller = new AbortController();
		this.searchAbort = controller;

		this.searchResultsEl.empty();
		if (query.trim() === "") {
			this.searchStatusEl.setText("");
			return;
		}

		const { searchDocument } = await import("./search");
		let shown = 0;

		const render = (hits: { page: number; snippet: string }[]) => {
			// Only the new ones: rebuilding the list on every page would flicker for 315 pages.
			for (const hit of hits.slice(shown)) {
				const row = this.searchResultsEl.createDiv({ cls: "reader-search-hit" });
				row.createSpan({ cls: "reader-search-page", text: `p${hit.page}` });
				row.createSpan({ cls: "reader-search-snippet", text: hit.snippet });
				this.registerDomEvent(row, "click", () => this.goToPage(hit.page, "smooth"));
			}
			shown = hits.length;
		};

		const hits = await searchDocument(query, surface.pageCount, (page) => surface.pageText(page), {
			signal: controller.signal,
			onProgress: ({ done, total, hits: found }) => {
				if (controller.signal.aborted) return;
				this.searchStatusEl.setText(
					done < total ? `${found.length} so far — searching ${done}/${total}…` : "",
				);
				render(found);
			},
		});

		if (controller.signal.aborted) return;
		this.searchStatusEl.setText(hits.length === 0 ? "No matches." : `${hits.length} matches`);
	}

	/**
	 * Set the display scale and re-render what is on screen.
	 *
	 * The pages are laid out by width, so zoom is simply a multiplier on the column's width —
	 * which keeps every position normalised and every mark correct without touching them.
	 */
	private async setZoom(next: number): Promise<void> {
		const clamped = Math.min(4, Math.max(0.5, Number(next.toFixed(3))));
		if (clamped === this.zoom) return;

		this.zoom = clamped;
		if (this.doc) {
			this.doc.view.zoom = clamped;
			this.requestSave();
		}

		this.scroller.style.setProperty("--reader-zoom", String(clamped));
		this.setStatus(`${Math.round(clamped * 100)}% · = and - to zoom, 0 to reset`);
		await this.rerenderVisible();
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

			if (document.source.kind === "epub") {
				const epub = await EpubSurface.open(bytes);
				if (token !== this.loadToken) return;

				this.epub = epub;
				this.doc = document;
				this.doc = await this.reconcileWithNote(document);
				this.window = new PageWindow({ total: epub.count, budget: this.deps.pageBudget });
				if (this.file) this.deps.onPageCount?.(this.file.path, epub.count);

				await this.buildPages(epub.count, 1.4);
				this.buildOutlineFrom(epub.outline());
				this.goToPage(document.view.surface, "auto");
				this.watchNote();
				this.setStatus(`${epub.count} sections · q quote · r figure · shift = parent`);
				return;
			}

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
			// The shelf cannot know how long a document is until something has opened it.
			if (this.file) this.deps.onPageCount?.(this.file.path, surface.pageCount);

			await this.buildPages();
			await this.buildOutline();
			// Reopen where you left off. `.reader` has recorded this all along and nothing ever
			// acted on it, so a 142-page workbook started at page 1 every single time.
			this.zoom = Math.min(4, Math.max(0.5, document.view.zoom || 1));
			this.scroller.style.setProperty("--reader-zoom", String(this.zoom));
			this.goToPage(document.view.surface, "auto");
			this.watchNote();
			this.setStatus(`${surface.pageCount} pages · q quote · r region · p page · shift = parent · f find · o outline`);
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

	private async buildPages(count?: number, ratioOverride?: number): Promise<void> {
		const surface = this.surface;
		if (!surface && count === undefined) return;

		this.scroller.empty();
		this.pages.clear();

		/*
		 * One page's aspect ratio stands in for all of them, so the scrollbar is right
		 * immediately. Asking pdf.js for 315 page sizes up front costs seconds.
		 *
		 * A section has no intrinsic ratio — it is as tall as its text makes it — so the caller
		 * supplies a guess and the box grows to fit once the section is in.
		 */
		const total = count ?? surface?.pageCount ?? 0;
		let ratio = ratioOverride ?? 1.4;
		if (ratioOverride === undefined && surface) {
			const first = await surface.size(1);
			ratio = first.height / first.width;
		}

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

		for (let n = 1; n <= total; n++) {
			const page = createPageElement(n);
			page.root.style.aspectRatio = `1 / ${ratio}`;
			this.pages.set(n, page);
			this.scroller.append(page.root);
			observer.observe(page.root);
		}
	}

	/**
	 * The document's own table of contents, when it has one.
	 *
	 * Most slide decks carry none, so the panel is hidden rather than shown empty. Resolving
	 * each entry to a page costs a worker round trip, so it happens once on open.
	 */
	private async buildOutline(): Promise<void> {
		const surface = this.surface;
		if (!surface) return;

		this.buildOutlineFrom(await surface.outline().catch(() => []));
	}

	/** Render a table of contents, whatever produced it. */
	private buildOutlineFrom(entries: OutlineEntry[]): void {
		this.outline = entries;
		this.outlineEl.empty();

		if (entries.length === 0) {
			this.outlineEl.addClass("is-empty");
			return;
		}
		this.outlineEl.removeClass("is-empty");

		for (const entry of entries) {
			const item = this.outlineEl.createDiv({ cls: "reader-outline-item", text: entry.title });
			item.style.paddingLeft = `${0.5 + entry.depth * 0.75}em`;
			if (entry.page === undefined) {
				item.addClass("is-unresolved");
				continue;
			}
			item.dataset.page = String(entry.page);
			this.registerDomEvent(item, "click", () => this.goToPage(entry.page as number, "smooth"));
		}
	}

	/** Scroll a page into view, and remember it. */
	private goToPage(pageNumber: number, behavior: ScrollBehavior = "smooth"): void {
		const page = this.pages.get(Math.min(this.surface?.pageCount ?? 1, Math.max(1, pageNumber)));
		if (!page) return;

		page.root.scrollIntoView({ behavior, block: "start" });
		void this.goTo(pageNumber);
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
			// An object URL keeps its blob alive for the life of the document.
			this.sectionReleases.get(n)?.();
			this.sectionReleases.delete(n);
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
		const page = this.pages.get(pageNumber);
		if (!page) return;

		if (this.epub) {
			try {
				const { element, release } = await this.epub.renderSection(pageNumber);
				if (signal.aborted) {
					release();
					return;
				}

				this.sectionReleases.get(pageNumber)?.();
				this.sectionReleases.set(pageNumber, release);

				page.canvasHost.replaceChildren(...Array.from(element.childNodes));
				// A section is as tall as its text; a fixed ratio would clip or pad it.
				page.root.style.aspectRatio = "";
				page.root.addClass("is-section");
				this.drawMarks(pageNumber);
			} catch (error) {
				if (!signal.aborted) this.deps.log.warn(`section ${pageNumber} did not render`, error);
			}
			return;
		}

		const surface = this.surface;
		if (!surface) return;

		try {
			const cssWidth = Math.max(200, (this.scroller.clientWidth - 32) * this.zoom);
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

		/*
		 * Shift makes the clip a **parent**: everything clipped after it, up to the next
		 * parent, nests beneath it. Scope runs by position rather than by page, because in a
		 * prose PDF a section's material routinely starts partway down the page before its
		 * heading and ends partway down the page after.
		 */
		const asParent = event.shiftKey;

		switch (event.key.toLowerCase()) {
			case "q":
				event.preventDefault();
				void this.clipSelection(asParent);
				break;
			case "r":
				event.preventDefault();
				if (this.epub) {
					// There is no page to crop. `r` takes the figure under the pointer instead.
					this.armFigure(asParent);
				} else {
					this.armRegion(asParent);
				}
				break;
			case "p":
				event.preventDefault();
				void this.clipWholePage(asParent);
				break;
			case "f":
				event.preventDefault();
				this.toggleSearch(true);
				break;
			case "o":
				event.preventDefault();
				if (this.outline.length === 0) {
					new Notice("Reader: this document has no table of contents.");
					break;
				}
				this.outlineEl.toggleClass("is-hidden", !this.outlineEl.hasClass("is-hidden"));
				break;
			case "=":
			case "+":
				event.preventDefault();
				void this.setZoom(this.zoom * 1.25);
				break;
			case "-":
				event.preventDefault();
				void this.setZoom(this.zoom / 1.25);
				break;
			case "0":
				event.preventDefault();
				void this.setZoom(1);
				break;
			// Escape is handled on the document while armed — see armRegion().
		}
	}

	/** Wait for a click on a figure, then clip that figure's file. */
	private armFigure(asParent = false): void {
		this.setStatus("Click a figure to clip it. Escape to cancel.");
		this.scroller.addClass("is-arming-region");

		const onClick = (event: MouseEvent) => {
			cleanup();
			void this.clipEpubFigure(event.target as HTMLElement, asParent);
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			cleanup();
		};
		const cleanup = () => {
			this.scroller.removeEventListener("click", onClick, true);
			document.removeEventListener("keydown", onEscape, true);
			this.scroller.removeClass("is-arming-region");
			this.setStatus(`${this.epub?.count ?? 0} sections · q quote · r figure · shift = parent`);
		};

		this.scroller.addEventListener("click", onClick, true);
		document.addEventListener("keydown", onEscape, true);
		this.register(cleanup);
	}

	private armRegion(asParent = false): void {
		this.pendingParent = asParent;
		this.mode = "arming-region";
		this.scroller.addClass("is-arming-region");
		this.setStatus(
			asParent
				? "Drag a box around the parent. Everything after it nests underneath. Escape to cancel."
				: "Drag a box around what you want. Escape to cancel.",
		);

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
		this.pendingParent = false;
		this.escapeHandler?.();
		this.escapeHandler = undefined;
		this.scroller.removeClass("is-arming-region");
		this.setStatus(`${this.surface?.pageCount ?? 0} pages · q quote · r region · p page · shift = parent · f find · o outline`);
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

			const asParent = this.pendingParent;
			this.disarmRegion();
			void this.clipRegion(pageNumber, normalised, asParent);
		};

		// Listeners live on the document so a drag that leaves the page still completes, and
		// both are removed in `onUp` whatever happens.
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}

	// ------------------------------------------------------------------------- clipping

	private async clipSelection(asParent = false): Promise<void> {
		const doc = this.doc;
		if (!doc) return;

		// A section is already a DOM, so the selection is the text — no layer to reconcile, and
		// the structure comes from real headings and lists rather than being inferred.
		if (this.epub) return this.clipEpubSelection(asParent);

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
			isParent: asParent,
			locator: {
				surface: { kind: "pdf-page", index: pageNumber },
				rect: captured.rect,
				quote: captured.quote,
			},
		});

		selection?.removeAllRanges();
	}

	/**
	 * A quote from a book.
	 *
	 * The text is exactly what the browser reports, because the markup is the book's own — none
	 * of the geometry reconstruction a PDF needs, and none of its failure modes.
	 */
	private async clipEpubSelection(asParent: boolean): Promise<void> {
		const selection = activeWindow.getSelection();
		const text = (selection?.toString() ?? "").replace(/\s+/g, " ").trim();

		if (text === "") {
			new Notice("Reader: select some text first.");
			return;
		}

		const pageEl = selection?.anchorNode
			? ((selection.anchorNode as Node).parentElement?.closest(".reader-page") as HTMLElement | null)
			: null;
		const index = Number(pageEl?.dataset.page);
		if (!pageEl || !Number.isFinite(index)) return;

		const rect = this.selectionRectWithin(selection, pageEl);
		const context = this.epub ? await this.epub.sectionText(index) : "";
		const at = context.indexOf(text);

		await this.commit({
			kind: "quote",
			text,
			isParent: asParent,
			locator: {
				surface: { kind: "epub-section", index },
				...(rect ? { rect } : {}),
				quote: {
					exact: text,
					prefix: at >= 0 ? context.slice(Math.max(0, at - 32), at) : "",
					suffix: at >= 0 ? context.slice(at + text.length, at + text.length + 32) : "",
				},
			},
		});

		selection?.removeAllRanges();
	}

	/** Where a selection sits within a section, normalised, so the mark can be redrawn. */
	private selectionRectWithin(selection: Selection | null, pageEl: HTMLElement): NormalisedRect | undefined {
		if (!selection || selection.rangeCount === 0) return undefined;

		const box = selection.getRangeAt(0).getBoundingClientRect();
		const within = pageEl.getBoundingClientRect();
		if (within.width <= 0 || within.height <= 0) return undefined;

		return toNormalised(
			{
				x: box.left - within.left,
				y: box.top - within.top,
				width: box.width,
				height: box.height,
			},
			within.width,
			within.height,
		);
	}

	/**
	 * A figure from a book, taken as the file rather than a picture of it.
	 *
	 * A PDF has to be rasterised because its figure is drawing instructions. An EPUB's figure
	 * is already an image file, so the clip is the publisher's own artwork at full resolution
	 * with no DPI decision to make — strictly better than a screenshot.
	 */
	private async clipEpubFigure(target: HTMLElement, asParent: boolean): Promise<void> {
		const epub = this.epub;
		const doc = this.doc;
		if (!epub || !doc || !this.file) return;

		const img = target.closest("img") as HTMLImageElement | null;
		const src = img?.dataset.readerSrc;
		const pageEl = target.closest(".reader-page") as HTMLElement | null;
		const index = Number(pageEl?.dataset.page);

		if (!src || !Number.isFinite(index)) {
			new Notice("Reader: click a figure to clip it.");
			return;
		}

		const found = await epub.readImage(index, src);
		if (!found) {
			new Notice("Reader: that figure is not in the book's archive.");
			return;
		}

		const assetPath = await this.writeAsset(
			this.file.basename,
			index,
			found.bytes,
			extensionOf(found.path),
		);

		const clip = makeClip(
			{ kind: "image", isParent: asParent, locator: { surface: { kind: "epub-section", index } } },
			{ documentId: this.file.path },
			assetPath,
		);

		await this.writeClip(clip, index);
	}

	private async clipRegion(pageNumber: number, rect: NormalisedRect, asParent: boolean): Promise<void> {
		await this.commitImage(pageNumber, rect, asParent);
	}

	private async clipWholePage(asParent = false): Promise<void> {
		if (this.epub) {
			// A section is not a page — SOURCES.md decision K. Saying so beats inventing a
			// multi-megabyte image of a whole chapter.
			new Notice("Reader: a section has no page to clip. Select text, or press r for a figure.");
			return;
		}
		const current = this.doc?.view.surface ?? 1;
		await this.commitImage(current, WHOLE_SURFACE, asParent);
	}

	private async commitImage(pageNumber: number, rect: NormalisedRect, asParent = false): Promise<void> {
		const surface = this.surface;
		if (!surface) return;

		try {
			const png = await surface.renderRegion(pageNumber, rect, this.deps.clipDpi);
			await this.commit({
				kind: "image",
				png,
				isParent: asParent,
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
			await this.writeClip(clip, request.locator.surface.index);
		} catch (error) {
			this.deps.log.error("could not save the clip", error);
			const message = error instanceof Error ? error.message : "The clip could not be saved.";
			new Notice(`Reader: ${message}`, 10_000);
		}
	}

	/**
	 * Put a finished clip into the note, record its mark, and take the cursor there.
	 *
	 * Shared by every capture path, because the note format, the ordering and the parent rules
	 * are properties of a clip rather than of the thing it came from — and a second copy of
	 * this is how the two write paths in v1 drifted apart.
	 */
	private async writeClip(clip: Clip, index: number): Promise<void> {
		const doc = this.doc;
		if (!doc) return;

		try {
			// Page order, not capture order: you clip a figure on page 12 and then go back for
			// the definition on page 3, and the note should still read straight through.
			const position = await appendClip(this.app, doc.notePath, clip, {
				sections: this.sectionsFor(index),
				positionAt: (blockId) => {
					const parents = new Set((doc.parents ?? []).map((id) => id.toLowerCase()));
					for (const [id, locator] of Object.entries(doc.clips)) {
						if (id.toLowerCase() === blockId) return positionOf(locator, parents.has(blockId));
					}
					return undefined;
				},
			});

			doc.clips[clip.id] = clip.locator;
			if (clip.isParent) doc.parents = [...(doc.parents ?? []), clip.id];
			this.requestSave();
			this.drawMarks(index);

			await this.revealNote(position);
		} catch (error) {
			this.deps.log.error("could not save the clip", error);
			const message = error instanceof Error ? error.message : "The clip could not be saved.";
			new Notice(`Reader: ${message}`, 10_000);
		}
	}

	/**
	 * The sections a page falls in, outermost first.
	 *
	 * Only entries whose destination resolved to a page can place anything, so an outline with
	 * broken links contributes the parts that work rather than nothing.
	 */
	private sectionsFor(page: number): Section[] {
		const usable = this.outline.filter(
			(entry): entry is OutlineEntry & { page: number } => typeof entry.page === "number",
		);
		return sectionsForPage(usable as Section[], page);
	}

	private async writeAsset(
		basename: string,
		pageNumber: number,
		bytes: Uint8Array,
		extension = "png",
	): Promise<string> {
		const folder = `${this.deps.assetsFolder}/${sanitise(basename)}`;
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {
				// Concurrent clips race here; an existing folder is the outcome either way.
			});
		}

		const stamp = Date.now().toString(36);
		const path = `${folder}/p${pageNumber}-${stamp}.${extension}`;
		await this.app.vault.createBinary(path, toArrayBuffer(bytes));
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

/** A path's extension, lowercased, defaulting to png when it has none. */
function extensionOf(path: string): string {
	const name = path.split("/").pop() ?? "";
	const at = name.lastIndexOf(".");
	return at === -1 ? "png" : name.slice(at + 1).toLowerCase();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

export { createDocument };
