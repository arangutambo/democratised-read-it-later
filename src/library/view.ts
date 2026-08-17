/**
 * The library pane: every document Reader knows about, and where you are in it.
 *
 * A shelf, not a file explorer. Obsidian already has a file explorer, and it shows `.reader`
 * files as opaque names with no sense of what is half-read. What this adds is state — how far
 * through, how much has come out — which is the only reason to look at a list of documents
 * rather than at the documents.
 *
 * Everything is derived from the `.reader` files themselves, so there is no index to go stale.
 */

import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";

import { parseDocument } from "../reader/document";
import {
	filterEntries,
	sortEntries,
	subtitleOf,
	toEntry,
	type LibraryEntry,
	type SortKey,
} from "./model";

export const LIBRARY_VIEW_TYPE = "reader-library";

export interface LibraryDeps {
	/** Page counts, once a document has been opened. Filled by the reader view. */
	pageCounts: Map<string, number>;
	onOpen: (path: string) => void;
}

export class LibraryView extends ItemView {
	private readonly deps: LibraryDeps;
	private entries: LibraryEntry[] = [];
	private query = "";
	private sort: SortKey = "recent";

	private listEl!: HTMLElement;
	private searchEl!: HTMLInputElement;

	constructor(leaf: WorkspaceLeaf, deps: LibraryDeps) {
		super(leaf);
		this.deps = deps;
	}

	getViewType(): string {
		return LIBRARY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Reader library";
	}

	override getIcon(): string {
		return "library";
	}

	protected override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("reader-library");

		const header = root.createDiv({ cls: "reader-library-header" });
		this.searchEl = header.createEl("input", { type: "search", placeholder: "Filter…" });
		this.registerDomEvent(this.searchEl, "input", () => {
			this.query = this.searchEl.value;
			this.render();
		});

		const sortEl = header.createEl("select");
		for (const [value, label] of [
			["recent", "Recent"],
			["title", "Title"],
			["progress", "Progress"],
		] as const) {
			sortEl.createEl("option", { value, text: label });
		}
		this.registerDomEvent(sortEl, "change", () => {
			this.sort = sortEl.value as SortKey;
			this.render();
		});

		this.listEl = root.createDiv({ cls: "reader-library-list" });

		/*
		 * Rebuild when a `.reader` changes, so progress on screen is progress in the file.
		 *
		 * Registered one event at a time: `vault.on` is overloaded per event name, so a loop
		 * over the names does not typecheck — and the compiler is right, they carry different
		 * payloads.
		 */
		const rebuild = (file: { path: string }): void => {
			if (file.path.endsWith(".reader")) void this.refresh();
		};
		this.registerEvent(this.app.vault.on("modify", rebuild));
		this.registerEvent(this.app.vault.on("create", rebuild));
		this.registerEvent(this.app.vault.on("delete", rebuild));
		this.registerEvent(this.app.vault.on("rename", rebuild));

		await this.refresh();
	}

	/** Read every `.reader` in the vault and rebuild the shelf. */
	async refresh(): Promise<void> {
		const files = this.app.vault
			.getFiles()
			.filter((file) => file.extension === "reader");

		const entries: LibraryEntry[] = [];
		for (const file of files) {
			try {
				const { document } = parseDocument(await this.app.vault.read(file));
				entries.push(
					toEntry({
						path: file.path,
						document,
						modified: file.stat.mtime,
						pages: this.deps.pageCounts.get(file.path),
					}),
				);
			} catch {
				// A `.reader` that will not parse is the reader view's problem to report, not
				// the shelf's — one bad file must not empty the list.
			}
		}

		this.entries = entries;
		this.render();
	}

	private render(): void {
		if (!this.listEl) return;
		this.listEl.empty();

		const shown = sortEntries(filterEntries(this.entries, this.query), this.sort);

		if (shown.length === 0) {
			this.listEl.createDiv({
				cls: "reader-library-empty",
				text:
					this.entries.length === 0
						? "Nothing here yet. Right-click a PDF and choose Open in Reader."
						: "Nothing matches that.",
			});
			return;
		}

		for (const entry of shown) {
			const row = this.listEl.createDiv({ cls: `reader-library-row is-${entry.state}` });

			const icon = row.createDiv({ cls: "reader-library-icon" });
			setIcon(icon, entry.state === "finished" ? "check" : "book-open");

			const text = row.createDiv({ cls: "reader-library-text" });
			text.createDiv({ cls: "reader-library-title", text: entry.title });
			const subtitle = subtitleOf(entry);
			if (subtitle !== "") text.createDiv({ cls: "reader-library-subtitle", text: subtitle });

			if (entry.progress !== undefined) {
				const bar = row.createDiv({ cls: "reader-library-progress" });
				bar.createDiv({ cls: "reader-library-progress-fill" }).style.width =
					`${Math.round(entry.progress * 100)}%`;
			}

			this.registerDomEvent(row, "click", () => this.deps.onOpen(entry.path));
		}
	}

	protected override async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
