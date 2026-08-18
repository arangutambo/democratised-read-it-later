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

import { ItemView, setIcon, TFile, type WorkspaceLeaf } from "obsidian";

import { parseDocument } from "../reader/document";
import {
	countsByState,
	filterEntries,
	ofState,
	sortEntries,
	subtitleOf,
	toEntry,
	type LibraryEntry,
	type ReadingState,
	type SortKey,
} from "./model";

export const LIBRARY_VIEW_TYPE = "reader-library";

export interface LibraryDeps {
	/** Page counts, once a document has been opened. Filled by the reader view. */
	pageCounts: Map<string, number>;
	onOpen: (path: string) => void;
}

/** Rows drawn before the list waits for you to scroll. */
const PAGE = 60;

export class LibraryView extends ItemView {
	private readonly deps: LibraryDeps;

	/**
	 * Entries by path, not an array.
	 *
	 * A Readwise import lands ~2,100 `.reader` files, and the shelf used to re-read every one
	 * of them on every vault change — so a single clip, which writes its own `.reader`, cost
	 * 2,088 file reads. Keyed by path, one change touches one entry.
	 */
	private readonly entries = new Map<string, LibraryEntry>();

	private query = "";
	private sort: SortKey = "recent";
	private state: ReadingState | "all" = "all";
	/** How many rows are currently drawn. Grows as you scroll; reset by any filter change. */
	private drawn = PAGE;

	private listEl!: HTMLElement;
	private chipsEl!: HTMLElement;
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
			this.drawn = PAGE;
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
			this.drawn = PAGE;
			this.render();
		});

		/*
		 * State before the list.
		 *
		 * 2,088 rows is not a shelf, it is a wall — Hick's law at its worst. The counts turn it
		 * into four facts you can act on, and reading comes first because unfinished work is
		 * what you opened this pane for.
		 */
		this.chipsEl = root.createDiv({ cls: "reader-library-chips" });

		this.listEl = root.createDiv({ cls: "reader-library-list" });

		// Draw more only as they are needed; 2,088 rows at once misses Doherty by seconds.
		this.registerDomEvent(root, "scroll", () => {
			if (root.scrollTop + root.clientHeight < root.scrollHeight - 400) return;
			if (this.drawn >= this.shown().length) return;

			this.drawn += PAGE;
			this.render();
		});

		/*
		 * One changed file is one changed entry.
		 *
		 * `modify` fires on every clip, because a clip writes its own `.reader`. Re-reading the
		 * whole vault there is what made the shelf unusable after an import.
		 */
		this.registerEvent(this.app.vault.on("modify", (file) => void this.touch(file.path)));
		this.registerEvent(this.app.vault.on("create", (file) => void this.touch(file.path)));
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (this.entries.delete(file.path)) this.render();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.entries.delete(oldPath);
				void this.touch(file.path);
			}),
		);

		await this.refresh();
	}

	/** Re-read one `.reader`, or ignore anything else. */
	private async touch(path: string): Promise<void> {
		if (!path.endsWith(".reader")) return;

		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		const entry = await this.readEntry(file);
		if (entry) {
			this.entries.set(path, entry);
			this.render();
		}
	}

	private async readEntry(file: TFile): Promise<LibraryEntry | undefined> {
		try {
			const { document } = parseDocument(await this.app.vault.read(file));
			return toEntry({
				path: file.path,
				document,
				modified: file.stat.mtime,
				pages: this.deps.pageCounts.get(file.path),
			});
		} catch {
			// A `.reader` that will not parse is the reader view's problem to report, not the
			// shelf's — one bad file must not empty the list.
			return undefined;
		}
	}

	/** Read every `.reader` in the vault. Only on open — after that, one file at a time. */
	async refresh(): Promise<void> {
		const files = this.app.vault.getFiles().filter((file) => file.extension === "reader");

		this.entries.clear();
		for (const file of files) {
			const entry = await this.readEntry(file);
			if (entry) this.entries.set(file.path, entry);
		}

		/*
		 * Land on what is in progress, when there is any.
		 *
		 * After an import "all" is 2,088 rows of things you have never opened, and the dozen
		 * you are actually reading are buried in it. Unfinished work is both what you came for
		 * and what stays on your mind.
		 */
		if (this.state === "all" && countsByState([...this.entries.values()]).reading > 0) {
			this.state = "reading";
		}

		this.render();
	}

	/** The entries currently on show, in order. */
	private shown(): LibraryEntry[] {
		const all = [...this.entries.values()];
		return sortEntries(filterEntries(ofState(all, this.state), this.query), this.sort);
	}

	private render(): void {
		if (!this.listEl) return;

		this.renderChips();
		this.listEl.empty();

		const shown = this.shown();

		if (shown.length === 0) {
			this.listEl.createDiv({
				cls: "reader-library-empty",
				text:
					this.entries.size === 0
						? "Nothing here yet. Right-click a PDF and choose Open in Reader."
						: "Nothing matches that.",
			});
			return;
		}

		for (const entry of shown.slice(0, this.drawn)) this.renderRow(entry);

		const remaining = shown.length - this.drawn;
		if (remaining > 0) {
			this.listEl.createDiv({
				cls: "reader-library-more",
				text: `${remaining} more — keep scrolling, or filter`,
			});
		}
	}

	/**
	 * The state filter, as counts.
	 *
	 * A label and a figure, the figure carrying the weight: "2073" reads at a glance where
	 * "2073 unread documents" has to be parsed. Four chips, which is inside what anyone holds
	 * in mind at once.
	 */
	private renderChips(): void {
		this.chipsEl.empty();

		const all = [...this.entries.values()];
		const counts = countsByState(all);

		const chips: { key: ReadingState | "all"; label: string; count: number }[] = [
			{ key: "reading", label: "Reading", count: counts.reading },
			{ key: "unread", label: "Unread", count: counts.unread },
			{ key: "finished", label: "Done", count: counts.finished },
			{ key: "all", label: "All", count: all.length },
		];

		for (const chip of chips) {
			const el = this.chipsEl.createDiv({
				cls: `reader-library-chip${this.state === chip.key ? " is-active" : ""}`,
			});
			el.createDiv({ cls: "reader-library-chip-count", text: String(chip.count) });
			el.createDiv({ cls: "reader-library-chip-label", text: chip.label });

			this.registerDomEvent(el, "click", () => {
				this.state = chip.key;
				this.drawn = PAGE;
				this.render();
			});
		}
	}

	private renderRow(entry: LibraryEntry): void {
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

	protected override async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
