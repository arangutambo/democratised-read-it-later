import { MarkdownView, Notice, Platform, Plugin } from "obsidian";

import { Disposables } from "./core/disposables";
import { Logger } from "./core/log";
import { readerSkin } from "./render/reader-skin";
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
