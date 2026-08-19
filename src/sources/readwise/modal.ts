/**
 * The Readwise import, as a dialog.
 *
 * Two steps, deliberately. A real library is ~2,100 documents and roughly a gigabyte of
 * uploaded files; that is not something to start from a command palette entry and discover
 * afterwards. So: choose the files, see exactly what would be written, then decide.
 *
 * The files are read through the browser's own file input rather than a path, so this works
 * the same wherever Obsidian runs and never reaches outside what you handed it.
 */

import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";

import { ZipArchive } from "../../epub/zip";
import { parseExport } from "./export";
import { describePlan, planImport } from "./import";
import { runImport, type RunSummary } from "./run";

export interface ReadwiseImportOptions {
	sourcesFolder: string;
	documentsFolder: string;
	onDone?: (summary: RunSummary) => void;
}

export class ReadwiseImportModal extends Modal {
	private readonly options: ReadwiseImportOptions;

	private csv?: string;
	private zip?: Uint8Array;
	private includeFeed = false;
	private running = false;
	private cancelled = false;

	private summaryEl!: HTMLElement;

	/**
	 * The component, not its element.
	 *
	 * `ButtonComponent` keeps its own `disabled` flag and its click listener returns early on
	 * it — `if (this.disabled || !callback) return`. Clearing the DOM attribute alone leaves
	 * that flag set, so the button renders enabled, receives the click, and silently discards
	 * it. Only `setDisabled` moves both.
	 */
	private importButton?: ButtonComponent;

	constructor(app: App, options: ReadwiseImportOptions) {
		super(app);
		this.options = options;
	}

	override onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("reader-import-modal");

		contentEl.createEl("h3", { text: "Import from Readwise" });
		contentEl.createEl("p", {
			cls: "reader-setting-note",
			text:
				"Built on the export, not the API — no token, no live subscription. " +
				"Download both files from Readwise (Export → CSV, and the uploaded files zip), " +
				"then point at them here.",
		});

		this.addFilePicker(
			contentEl,
			"Export CSV",
			"The list of documents: titles, links, tags, reading progress.",
			".csv,text/csv",
			async (file) => {
				this.csv = await file.text();
				return `${file.name} — ${parseExport(this.csv).length} documents`;
			},
		);

		this.addFilePicker(
			contentEl,
			"Uploaded files (optional)",
			"The documents themselves. Without it you get notes with links and nothing to read.",
			".zip,application/zip",
			async (file) => {
				this.zip = new Uint8Array(await file.arrayBuffer());
				return `${file.name} — ${(file.size / 1e6).toFixed(0)} MB`;
			},
		);

		new Setting(contentEl)
			.setName("Include the feed")
			.setDesc(
				"Your RSS feed is usually most of the export and is not a library you keep. " +
					"Leave this off unless you want all of it.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.includeFeed).onChange((value) => {
					this.includeFeed = value;
					this.refreshSummary();
				}),
			);

		this.summaryEl = contentEl.createDiv({ cls: "reader-import-summary" });

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.cancelled = true;
					this.close();
				}),
			)
			.addButton((button) => {
				this.importButton = button;
				button
					.setButtonText("Import")
					.setCta()
					.setDisabled(true)
					.onClick(() => void this.run());
			});

		this.refreshSummary();
	}

	/**
	 * A file input, styled as a setting.
	 *
	 * `<input type="file">` rather than a path box: the vault adapter cannot read outside the
	 * vault, and asking you to copy a gigabyte of zip into the vault first to import it would
	 * be absurd.
	 */
	private addFilePicker(
		parent: HTMLElement,
		name: string,
		description: string,
		accept: string,
		load: (file: File) => Promise<string>,
	): void {
		const setting = new Setting(parent).setName(name).setDesc(description);
		const status = setting.descEl.createDiv({ cls: "reader-import-file" });

		const input = setting.controlEl.createEl("input", { type: "file" });
		input.accept = accept;

		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) return;

			status.setText("Reading…");
			void load(file)
				.then((label) => status.setText(label))
				.catch((error: unknown) => {
					status.setText(`could not be read: ${error instanceof Error ? error.message : String(error)}`);
					status.addClass("is-error");
				})
				.finally(() => this.refreshSummary());
		});
	}

	/** What this would write, recomputed whenever an input changes. */
	private refreshSummary(): void {
		if (this.running) return;

		this.summaryEl.empty();
		this.importButton?.setDisabled(this.csv === undefined);

		if (this.csv === undefined) {
			this.summaryEl.setText("Choose the export CSV to see what would be imported.");
			return;
		}

		try {
			const plan = planImport(parseExport(this.csv), {
				sourcesFolder: this.options.sourcesFolder,
				documentsFolder: this.options.documentsFolder,
				// Names only — planning never inflates anything, so this stays instant.
				zipEntries: this.zipEntryNames(),
				existingNotes: new Set(this.app.vault.getMarkdownFiles().map((file) => file.path)),
				includeFeed: this.includeFeed,
			});

			this.summaryEl.createDiv({ text: describePlan(plan) });

			if (this.zip === undefined) {
				this.summaryEl.createDiv({
					cls: "reader-setting-note",
					text: "Without the uploaded-files zip these are notes with links — nothing to open in Reader.",
				});
			}
		} catch (error) {
			this.summaryEl.setText(`That CSV could not be read: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * The zip's entry names, for planning.
	 *
	 * Only the central directory is read — nothing is inflated — so this stays instant on a
	 * gigabyte archive and can run on every toggle. A zip that will not open plans as no zip,
	 * which shows up honestly in the summary as "as a link".
	 */
	private zipEntryNames(): string[] {
		if (!this.zip) return [];

		try {
			return ZipArchive.open(this.zip).names;
		} catch {
			return [];
		}
	}

	private async run(): Promise<void> {
		if (this.csv === undefined || this.running) return;

		this.running = true;
		this.importButton?.setDisabled(true);
		this.summaryEl.empty();

		const progress = this.summaryEl.createDiv({ text: "Starting…" });

		try {
			const summary = await runImport(this.app, {
				csv: this.csv,
				zip: this.zip,
				sourcesFolder: this.options.sourcesFolder,
				documentsFolder: this.options.documentsFolder,
				includeFeed: this.includeFeed,
				shouldStop: () => this.cancelled,
				onProgress: ({ current, total, label }) => {
					progress.setText(`${current} / ${total} — ${label}`);
				},
			});

			this.options.onDone?.(summary);
			this.close();

			const parts = [`${summary.notes} notes`];
			if (summary.documents > 0) parts.push(`${summary.documents} documents`);
			if (summary.readers > 0) parts.push(`${summary.readers} openable in Reader`);
			if (summary.failures.length > 0) parts.push(`${summary.failures.length} failed — see the console`);
			if (summary.stopped) parts.push("stopped early");

			new Notice(`Reader: imported ${parts.join(", ")}.`, 15_000);
		} catch (error) {
			this.running = false;
			this.summaryEl.setText(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
			this.importButton?.setDisabled(false);
		}
	}

	override onClose(): void {
		// Stops a run in progress; what is already written stays.
		this.cancelled = true;
		this.contentEl.empty();
	}
}
