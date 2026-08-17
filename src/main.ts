import { MarkdownView, Notice, Platform, Plugin, TFile } from "obsidian";

import { Disposables } from "./core/disposables";
import { Logger } from "./core/log";
import { findExcalidraw } from "./excalidraw/handoff";
import { isReadable } from "./reader/open";
import { READER_VIEW_TYPE, ReaderView } from "./reader/view";
import { readerSkin } from "./render/reader-skin";
import { collectQueue, ensureQueueBase } from "./review/queue";
import { migrateSettings } from "./settings/migrate";
import { ReaderSettingTab } from "./settings/tab";
import { DEFAULT_SETTINGS, type ReaderSettings } from "./settings/types";
import type { ColourResolver } from "./template/variables";

export default class ReaderPlugin extends Plugin {
	// `Plugin` declares `settings?: unknown` as of the 1.13 typings; narrow it to ours.
	override settings: ReaderSettings = structuredClone(DEFAULT_SETTINGS);

	/**
	 * Teardown registry for anything Obsidian does not already manage. Obsidian's own
	 * `register*` methods are lifecycle-managed and do not belong here; raw listeners,
	 * observers, intervals and iframes do. `onunload()` drains it.
	 */
	readonly disposables = new Disposables();

	readonly log = new Logger("[reader]");

	private settingTab?: ReaderSettingTab;
	/** Built on first use; a second paper must not re-copy and re-read the whole library. */
	private zoteroIndex?: import("./sources/zotero/lookup").ZoteroIndex;

	override async onload(): Promise<void> {
		try {
			await this.loadSettings();
		} catch (error) {
			// A broken data.json must not stop the plugin loading — the settings tab is the
			// only way the user could fix it, and it needs the plugin to be running.
			this.log.error("failed to load settings; falling back to defaults", error);
			this.settings = structuredClone(DEFAULT_SETTINGS);
			new Notice("Reader: settings could not be read. Defaults are in use — check the console.");
		}

		this.settingTab = new ReaderSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.features.readerSkin) return;
			readerSkin(el, ctx);
		});

		this.setUpReader();

		this.addCommand({
			id: "toggle-reader",
			name: "Toggle reader mode for this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return false;
				if (!checking) void this.toggleReader(file);
				return true;
			},
		});

		this.addCommand({
			id: "open-review-queue",
			name: "Open review queue",
			callback: () => void this.openReviewQueue(),
		});

		this.addCommand({
			id: "import-zotero",
			name: "Migrate highlights from Zotero",
			checkCallback: (checking) => {
				if (!Platform.isDesktopApp) return false;
				if (!checking) void this.importZotero();
				return true;
			},
		});

		this.addCommand({
			id: "import-apple-books",
			name: "Import highlights from Apple Books",
			checkCallback: (checking) => {
				// Reading Apple's SQLite needs Node and macOS; there is nothing to offer elsewhere.
				if (!Platform.isDesktopApp || !Platform.isMacOS) return false;
				if (!checking) void this.importAppleBooks();
				return true;
			},
		});

		this.log.info(`loaded v${this.manifest.version}`);
	}

	override onunload(): void {
		const errors = this.disposables.dispose();
		for (const { name, error } of errors) {
			this.log.error(`teardown failed for "${name}":`, error);
		}
		this.log.info("unloaded");
	}

	/**
	 * The Reader view, its file type, and the one gesture that creates a document.
	 *
	 * `.reader` is registered rather than `.pdf`: core already owns `pdf`, and
	 * `registerExtensions` throws for an extension that is taken. See `reader/open.ts`.
	 */
	private setUpReader(): void {
		if (!this.settings.features.reader) return;

		this.registerView(
			READER_VIEW_TYPE,
			(leaf) =>
				new ReaderView(leaf, {
					clipDpi: this.settings.clipDpi,
					assetsFolder: this.settings.assetsFolder,
					// A rendered page is 10–15 MB of canvas. Mobile gets the floor, where memory
					// is the binding limit and a 315-page workbook is otherwise a dead tab.
					pageBudget: Platform.isMobile ? 3 : 5,
					log: this.log,
				}),
		);

		this.registerExtensions(["reader"], READER_VIEW_TYPE);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !isReadable(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Open in Reader")
						.setIcon("book-open")
						.onClick(() => void this.openInReader(file)),
				);
			}),
		);

		this.addCommand({
			id: "open-in-reader",
			name: "Open this PDF in Reader",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !isReadable(file)) return false;
				if (!checking) void this.openInReader(file);
				return true;
			},
		});

		this.addCommand({
			id: "send-clips-to-excalidraw",
			name: "Send clips from this note to Excalidraw",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				// Absent rather than broken when Excalidraw is not installed.
				if (!findExcalidraw(this.app)) return false;
				if (!checking) void this.sendClipsToExcalidraw(file);
				return true;
			},
		});
	}

	/**
	 * Tick clips in this note, and send them to its drawing.
	 *
	 * Excalidraw is downstream of Reader: Reader selects, Excalidraw draws. The clips arrive
	 * locked and framed so a pen stroke cannot drag a question sideways mid-solution.
	 */
	private async sendClipsToExcalidraw(note: TFile): Promise<void> {
		const ea = findExcalidraw(this.app);
		if (!ea) {
			new Notice("Reader: Excalidraw is not available.");
			return;
		}

		try {
			const { parseClips } = await import("./note/parse");
			const { ClipPicker } = await import("./excalidraw/picker");
			const { drawingPathFor, sendToExcalidraw } = await import("./excalidraw/handoff");

			const body = await this.app.vault.read(note);
			const images = parseClips(body).filter((clip) => clip.kind === "image");

			// The page each clip came from, for the frame labels. `.reader` is the only place
			// that knows, which is why it exists.
			const pages = await this.readerPagesFor(note);

			new ClipPicker(
				this.app,
				images.map((clip) => ({ ...clip, page: pages.get(clip.id) })),
				(assets, labels) => {
					if (assets.length === 0) return;
					void (async () => {
						try {
							const result = await sendToExcalidraw(this.app, {
								assets,
								labels,
								drawingPath: drawingPathFor(note.path),
								workingRoom: this.settings.excalidrawWorkingRoom / 100,
								ea,
							});
							new Notice(
								`Reader: sent ${result.sent} clip(s) to ${result.created ? "a new drawing" : "the drawing"}.`,
							);
						} catch (error) {
							this.log.error("could not send clips to Excalidraw", error);
							const message = error instanceof Error ? error.message : "The handoff failed.";
							new Notice(`Reader: ${message}`, 10_000);
						}
					})();
				},
			).open();
		} catch (error) {
			this.log.error("could not prepare the Excalidraw handoff", error);
			new Notice("Reader: could not read this note's clips — check the console.");
		}
	}

	/**
	 * Give a paper's note the citekey Better BibTeX already gave it.
	 *
	 * Silent when Zotero is not installed, not readable, or does not know the file — most of
	 * what you read is not in a reference manager, and a lecture deck does not want a
	 * bibliography entry. Only a genuine match writes anything.
	 */
	private async addPaperFrontmatter(notePath: string, pdfPath: string): Promise<void> {
		if (!this.settings.features.zotero || !Platform.isDesktopApp) return;

		try {
			const { ZoteroIndex } = await import("./sources/zotero/lookup");
			const { withPaperFrontmatter } = await import("./note/frontmatter");

			this.zoteroIndex ??= await ZoteroIndex.open(this.settings.zoteroDataDir);
			const match = this.zoteroIndex.find(pdfPath);
			if (!match) return;

			const note = this.app.vault.getFileByPath(notePath);
			if (!note) return;

			const body = await this.app.vault.read(note);
			const next = withPaperFrontmatter(body, { citekey: match.citekey, csl: match.csl });
			if (next === body) return;

			await this.app.vault.modify(note, next);
			const caveats: string[] = [];
			if (match.how === "filename") caveats.push("matched by filename, so check it is the right paper");
			if (match.citekeyFrom === "reader") {
				// A generated key will not resolve in library.bib. Pinning it in Better BibTeX is
				// the fix, and saying so beats letting a \cite fail at submission.
				caveats.push("Better BibTeX has no key for it yet, so this one will not match library.bib");
			}

			new Notice(
				`Reader: cite this as [@${match.citekey}]` +
					(caveats.length > 0 ? ` — ${caveats.join("; ")}.` : "."),
				caveats.length > 0 ? 12_000 : 6_000,
			);
		} catch (error) {
			// Zotero being absent or locked is ordinary; it must not stop a document opening.
			this.log.info("no Zotero metadata for this document", error);
		}
	}

	/** Clip id → page, from the `.reader` beside this note. Empty when there is none. */
	private async readerPagesFor(note: TFile): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		const readerPath = note.path.replace(/\.md$/, ".reader");
		const file = this.app.vault.getAbstractFileByPath(readerPath);
		if (!(file instanceof TFile)) return out;

		try {
			const { parseDocument } = await import("./reader/document");
			const { document } = parseDocument(await this.app.vault.read(file));
			for (const [id, locator] of Object.entries(document.clips)) {
				out.set(id.toLowerCase(), locator.surface.index);
			}
		} catch {
			// A missing or unreadable sidecar costs labels, never the handoff itself.
		}
		return out;
	}

	/** Create the `.reader` + `.md` pair for a PDF and open it. */
	private async openInReader(file: TFile): Promise<void> {
		try {
			const { ensurePair } = await import("./reader/open");
			const pair = await ensurePair(
				this.app,
				{ path: file.path, basename: file.basename, kind: "pdf" },
				this.settings.sourcesFolder,
			);

			// Citation identity, if Zotero knows this file. Written once, at creation, so a
			// citekey you have already cited is never moved under you.
			if (pair.created) await this.addPaperFrontmatter(pair.notePath, file.path);

			const readerFile = this.app.vault.getFileByPath(pair.readerPath);
			if (!readerFile) throw new Error(`${pair.readerPath} could not be opened.`);

			await this.app.workspace.getLeaf(false).openFile(readerFile);
		} catch (error) {
			this.log.error("could not open the document in Reader", error);
			const message = error instanceof Error ? error.message : "Could not open that document.";
			new Notice(`Reader: ${message}`, 10_000);
		}
	}

	/** Maps a raw source colour key such as `books:3` onto the user's own meaning for it. */
	get resolveColour(): ColourResolver {
		return (raw) => {
			if (!raw) return { name: "", css: "" };
			const match = this.settings.highlightColours.find((c) => c.sourceKeys.includes(raw));
			return match ? { name: match.name, css: match.css } : { name: "", css: "" };
		};
	}

	/**
	 * Everything awaiting a human: thin imports, orphaned highlights, edit conflicts.
	 *
	 * The queue is an Obsidian Base, so it keeps working with Reader disabled and needs no
	 * custom pane. An existing queue file is never overwritten — the user will have
	 * customised its views.
	 */
	private async openReviewQueue(): Promise<void> {
		try {
			const summary = collectQueue(this.app, this.settings.sourcesFolder);
			const { path, created } = await ensureQueueBase(this.app, this.settings.sourcesFolder);

			const file = this.app.vault.getFileByPath(path);
			if (file) await this.app.workspace.getLeaf(false).openFile(file);

			const parts: string[] = [];
			if (summary.needsReview > 0) parts.push(`${summary.needsReview} needing review`);
			if (summary.orphans > 0) parts.push(`${summary.orphans} orphaned highlight(s)`);
			if (summary.conflicts > 0) parts.push(`${summary.conflicts} conflict(s)`);

			new Notice(
				parts.length === 0
					? created
						? "Reader: queue created. Nothing needs attention."
						: "Reader: nothing needs attention."
					: `Reader: ${parts.join(", ")}.`,
			);
		} catch (error) {
			this.log.error("could not open the review queue", error);
			new Notice("Reader: could not open the review queue — check the console.");
		}
	}

	private async importZotero(): Promise<void> {
		if (!this.settings.features.zotero) {
			new Notice("Reader: enable Zotero in settings first.");
			return;
		}

		const { importFromZotero, ZoteroUnavailableError } = await import("./sources/zotero/import");
		const notice = new Notice("Reader: reading Zotero…", 0);

		try {
			const summary = await importFromZotero(this.app, {
				sourcesFolder: this.settings.sourcesFolder,
				confidenceThreshold: this.settings.importConfidenceThreshold,
				resolveColour: this.resolveColour,
				dataDir: this.settings.zoteroDataDir,
				onProgress: (current, total, label) => notice.setMessage(`Reader: ${current}/${total} — ${label}`),
			});

			for (const warning of summary.warnings) this.log.warn(warning);
			for (const note of summary.notes) {
				for (const warning of note.warnings) this.log.warn(`${note.title}: ${warning}`);
			}

			const parts = [
				`${summary.totalHighlights} highlights across ${summary.notes.length} item(s)`,
				`${summary.created} new, ${summary.updated} updated, ${summary.unchanged} unchanged`,
			];
			if (summary.conflicts > 0) parts.push(`${summary.conflicts} conflict(s)`);
			if (summary.needsReview > 0) parts.push(`${summary.needsReview} need review`);

			notice.setMessage(`Reader: migrated ${parts.join(". ")}.`);
			window.setTimeout(() => notice.hide(), 12_000);
		} catch (error) {
			notice.hide();
			const message =
				error instanceof ZoteroUnavailableError ? error.message : "Zotero migration failed — check the console.";
			this.log.error("Zotero migration failed", error);
			new Notice(`Reader: ${message}`, 15_000);
		}
	}

	private async toggleReader(file: import("obsidian").TFile): Promise<void> {
		const { toggleReaderFrontmatter } = await import("./sources/books/import");
		try {
			const enabled = await toggleReaderFrontmatter(this.app, file);
			new Notice(enabled ? "Reader mode on" : "Reader mode off");
		} catch (error) {
			this.log.error("could not toggle reader frontmatter", error);
			new Notice("Reader: could not update this note's frontmatter — check the console.");
		}
	}

	private async importAppleBooks(): Promise<void> {
		if (!this.settings.features.booksImport) {
			new Notice("Reader: enable Apple Books import in settings first.");
			return;
		}

		// Lazily imported so mobile never evaluates the node builtins this pulls in.
		const { importFromAppleBooks } = await import("./sources/books/import");
		const { BooksUnavailableError } = await import("./sources/books/db");

		const notice = new Notice("Reader: reading Apple Books…", 0);
		try {
			const summary = await importFromAppleBooks(this.app, {
				sourcesFolder: this.settings.sourcesFolder,
				confidenceThreshold: this.settings.importConfidenceThreshold,
				resolveColour: this.resolveColour,
				onProgress: (progress) => {
					if (progress.stage === "writing") {
						notice.setMessage(`Reader: ${progress.current}/${progress.total} — ${progress.label ?? ""}`);
					}
				},
			});

			for (const warning of summary.warnings) this.log.warn(warning);
			for (const note of summary.notes) {
				for (const warning of note.warnings) this.log.warn(`${note.title}: ${warning}`);
			}

			const parts = [
				`${summary.totalHighlights} highlights across ${summary.notes.length} books`,
				`${summary.created} new, ${summary.updated} updated, ${summary.unchanged} unchanged`,
			];
			if (summary.conflicts > 0) parts.push(`${summary.conflicts} conflict(s) — see the .conflict.md files`);
			if (summary.needsReview > 0) parts.push(`${summary.needsReview} need review`);

			notice.setMessage(`Reader: imported ${parts.join(". ")}.`);
			window.setTimeout(() => notice.hide(), 10_000);
		} catch (error) {
			notice.hide();
			const message = error instanceof BooksUnavailableError ? error.message : "Import failed — check the console.";
			this.log.error("Apple Books import failed", error);
			new Notice(`Reader: ${message}`, 15_000);
		}
	}

	/**
	 * @param writeBack persist repairs made during load. Suppressed when reacting to an
	 * external change, so two synced devices cannot ping-pong writes at each other.
	 */
	async loadSettings(writeBack = true): Promise<void> {
		const { settings, changed, notes } = migrateSettings(await this.loadData());
		this.settings = settings;
		this.log.setLevel(settings.logLevel);

		for (const note of notes) this.log.warn(note);
		if (notes.length > 0) {
			new Notice(`Reader: settings were repaired on load.\n${notes.join("\n")}`, 10_000);
		}

		if (changed && writeBack) await this.saveData(this.settings);
	}

	async saveSettings(): Promise<void> {
		this.log.setLevel(this.settings.logLevel);
		await this.saveData(this.settings);
	}

	/** Fired when data.json is rewritten underneath us — typically Obsidian Sync. */
	override async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings(false);
		if (this.settingTab?.containerEl.isConnected) this.settingTab.display();
		this.log.info("settings reloaded after external change");
	}
}
