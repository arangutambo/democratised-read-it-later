import { MarkdownView, Notice, Platform, Plugin } from "obsidian";

import { Disposables } from "./core/disposables";
import { Logger } from "./core/log";
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
			id: "deck-to-study-note",
			name: "Turn this PDF into a study note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension.toLowerCase() !== "pdf") return false;
				if (!checking) void this.importDeckFile(file);
				return true;
			},
		});

		this.addCommand({
			id: "import-deck-inbox",
			name: "Import all PDFs from the inbox folder",
			checkCallback: (checking) => {
				// Reading a folder outside the vault needs Node.
				if (!Platform.isDesktopApp || this.settings.deckInboxPath === "") return false;
				if (!checking) void this.importDeckInbox();
				return true;
			},
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

	private get slideOptions() {
		return {
			sourcesFolder: this.settings.sourcesFolder,
			decksFolder: this.settings.decksFolder,
		};
	}

	/** Turn one PDF already in the vault into a study note. */
	private async importDeckFile(file: import("obsidian").TFile): Promise<void> {
		if (!this.settings.features.slidesImport) {
			new Notice("Reader: enable Slides import in settings first.");
			return;
		}

		const { importDeck, readVaultPdf, PdfUnavailableError } = await import("./sources/slides/import");
		const notice = new Notice(`Reader: reading ${file.name}…`, 0);

		try {
			const source = await readVaultPdf(this.app, file);
			const result = await importDeck(this.app, source, {
				...this.slideOptions,
				onProgress: (_stage, page, total) => notice.setMessage(`Reader: slide ${page}/${total}`),
			});

			for (const warning of result.warnings) this.log.warn(`${result.title}: ${warning}`);
			const unit = result.shape === "document" ? "sections" : "slides";
			notice.setMessage(`Reader: ${result.title} — ${result.slideCount} ${unit}, ${result.status}.`);
			window.setTimeout(() => notice.hide(), 8_000);
		} catch (error) {
			notice.hide();
			const message = error instanceof PdfUnavailableError ? error.message : "Could not read that PDF — check the console.";
			this.log.error("deck import failed", error);
			new Notice(`Reader: ${message}`, 15_000);
		}
	}

	/** Bulk-import every deck sitting in the configured inbox folder. */
	private async importDeckInbox(): Promise<void> {
		if (!this.settings.features.slidesImport) {
			new Notice("Reader: enable Slides import in settings first.");
			return;
		}

		const { importDeck, PdfUnavailableError } = await import("./sources/slides/import");
		// Separate module: it imports node builtins statically, which is the only form that
		// survives esbuild into a working require() inside Obsidian.
		const { readExternalPdfs, DeckInboxError } = await import("./sources/slides/inbox");
		const notice = new Notice("Reader: looking for slide decks…", 0);

		try {
			const decks = await readExternalPdfs(this.settings.deckInboxPath);
			if (decks.length === 0) {
				notice.setMessage(`Reader: no PDFs in ${this.settings.deckInboxPath}.`);
				window.setTimeout(() => notice.hide(), 8_000);
				return;
			}

			let created = 0;
			let updated = 0;
			let unchanged = 0;
			let documents = 0;
			const warnings: string[] = [];

			for (const [index, deck] of decks.entries()) {
				notice.setMessage(`Reader: ${index + 1}/${decks.length} — ${deck.fileName}`);
				const result = await importDeck(this.app, deck, this.slideOptions);

				if (result.status === "created") created++;
				else if (result.status === "updated") updated++;
				else unchanged++;
				if (result.shape === "document") documents++;
				for (const warning of result.warnings) warnings.push(`${result.title}: ${warning}`);

				// Let the UI breathe between decks; a 47-page extraction is not instant.
				await new Promise((resolve) => window.setTimeout(resolve, 0));
			}

			for (const warning of warnings) this.log.warn(warning);
			notice.setMessage(
				`Reader: ${decks.length} PDFs (${decks.length - documents} decks, ${documents} documents) — ` +
					`${created} new, ${updated} updated, ${unchanged} unchanged.` +
					(warnings.length > 0 ? ` ${warnings.length} warning(s) in the console.` : ""),
			);
			window.setTimeout(() => notice.hide(), 12_000);
		} catch (error) {
			notice.hide();
			const message =
				error instanceof PdfUnavailableError || error instanceof DeckInboxError
					? error.message
					: "Deck import failed — check the console.";
			this.log.error("deck inbox import failed", error);
			new Notice(`Reader: ${message}`, 15_000);
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
