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

import { ItemView, Menu, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";

import { parseDocument } from "../reader/document";
import { ConfirmModal } from "./confirm";
import { describeRemoval, writtenCharsIn, type RemovalPlan } from "./remove";
import {
	countsByState,
	filterEntries,
	ofState,
	sortEntries,
	stateOf,
	subtitleOf,
	toEntry,
	type LibraryEntry,
	type ReadingState,
	type SortKey,
} from "./model";

export const LIBRARY_VIEW_TYPE = "reader-library";

/**
 * Make a div behave like the button it looks like.
 *
 * A div with a click handler is invisible to the keyboard and to a screen reader, which for a
 * pane whose whole argument is that your hands stay on the keyboard is not a detail.
 */
function asButton(el: HTMLElement, label: string, activate: () => void): void {
	el.setAttribute("role", "button");
	el.setAttribute("tabindex", "0");
	el.setAttribute("aria-label", label);

	el.addEventListener("click", activate);
	el.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		activate();
	});
}

export interface AddedToLibrary {
	/** `.reader` paths created, in the order they were dropped. */
	added: string[];
	/** Names Reader cannot open, so the shelf can say which. */
	rejected: string[];
}

export interface LibraryDeps {
	/** Page counts, once a document has been opened. Filled by the reader view. */
	pageCounts: Map<string, number>;
	onOpen: (path: string) => void;
	/**
	 * Bring dropped files into the vault and give each one a document.
	 *
	 * The view knows a drop happened; it does not know where documents live or how a pair is
	 * made, and it should not — those are the plugin's, and they move with settings.
	 */
	onAdd?: (files: readonly File[]) => Promise<AddedToLibrary>;
}

/** Progress and state, recomputed when a page count finally arrives. */
function derivedFrom(entry: LibraryEntry, pages: number): Pick<LibraryEntry, "progress" | "state"> {
	return {
		progress: pages > 0 ? Math.min(1, entry.page / pages) : undefined,
		state: stateOf(entry.page, pages, entry.clips),
	};
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

	/**
	 * The last computed list, and the inputs it was computed from.
	 *
	 * `shown()` sorts 2,088 entries with `localeCompare`, which is not cheap, and the scroll
	 * handler called it on every scroll event — thousands of full locale sorts a second, which
	 * is enough to lock the window. It is recomputed when something it depends on changes and
	 * not otherwise.
	 */
	private cache?: { key: string; rows: LibraryEntry[] };

	private query = "";
	private sort: SortKey = "recent";
	private state: ReadingState | "all" = "all";
	/** How many rows are currently drawn. Grows as you scroll; reset by any filter change. */
	private drawn = PAGE;

	private listEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private statusEl!: HTMLElement;
	/** What the status line last said, so an unchanged shelf is not re-announced. */
	private announced = "";
	private searchEl!: HTMLInputElement;
	private sortEl!: HTMLSelectElement;
	/**
	 * Nesting depth of the current drag.
	 *
	 * `dragleave` fires when the pointer crosses into a *child*, so a single boolean turns the
	 * highlight off while the file is still over the pane. Counting enter and leave does not.
	 */
	private dragDepth = 0;

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
		// A placeholder is not a label: it is gone the moment you type, and a screen reader
		// gets no name for the field at all.
		this.searchEl.setAttribute("aria-label", "Filter the Reader library");
		this.registerDomEvent(this.searchEl, "input", () => {
			this.query = this.searchEl.value;
			this.drawn = PAGE;
			this.render();
		});

		const sortEl = header.createEl("select");
		this.sortEl = sortEl;
		sortEl.setAttribute("aria-label", "Sort the Reader library");
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

		/*
		 * One status line for the whole shelf.
		 *
		 * The counts change on their own — an import, a sync, finishing a document. Making each
		 * chip a live region would have four of them talking over each other announcing bare
		 * numbers; one atomic sentence says what actually changed.
		 */
		this.statusEl = root.createDiv({ cls: "reader-library-status" });
		this.statusEl.setAttribute("role", "status");
		this.statusEl.setAttribute("aria-atomic", "true");

		this.listEl = root.createDiv({ cls: "reader-library-list" });

		this.acceptDrops(root);

		// Draw more only as they are needed; 2,088 rows at once misses Doherty by seconds.
		this.registerDomEvent(root, "scroll", () => {
			// Cheap guard first: this runs on every scroll event, and `shown()` is not free.
			if (root.scrollTop + root.clientHeight < root.scrollHeight - 400) return;
			if (this.drawn >= this.shown().length) return;

			this.drawn += PAGE;
			this.scheduleRender();
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
				if (!this.entries.delete(file.path)) return;
				this.revision++;
				this.scheduleRender();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.entries.delete(oldPath)) this.revision++;
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
			this.revision++;
			this.scheduleRender();
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

	/**
	 * One document's page count, once the reader has worked it out.
	 *
	 * Deliberately not a rescan. This fires every time a document is opened, and rescanning the
	 * vault for it meant 2,088 file reads behind opening a single PDF.
	 */
	setPageCount(path: string, pages: number): void {
		const entry = this.entries.get(path);
		if (!entry || entry.pages === pages) return;

		this.entries.set(path, { ...entry, pages, ...derivedFrom(entry, pages) });
		this.revision++;
		this.scheduleRender();
	}

	/**
	 * Read every `.reader` in the vault. Only on open — after that, one file at a time.
	 *
	 * Yields every so often. 2,088 sequential reads with no break starve the event loop for
	 * long enough that the window stops responding, which is indistinguishable from a hang.
	 */
	async refresh(): Promise<void> {
		const files = this.app.vault.getFiles().filter((file) => file.extension === "reader");

		// A 2,000-file scan is seconds of work; an empty shelf with no explanation reads as
		// broken. Busy is set for the wait rather than a spinner flashing for a small vault.
		if (files.length > 200) {
			this.listEl?.setAttribute("aria-busy", "true");
			this.say(`Reading ${files.length} documents…`);
		}

		this.entries.clear();
		for (const [i, file] of files.entries()) {
			const entry = await this.readEntry(file);
			if (entry) this.entries.set(file.path, entry);

			if (i % 100 === 99) {
				this.revision++;
				this.render();
				await new Promise((resolve) => window.setTimeout(resolve, 0));
			}
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

		this.listEl?.removeAttribute("aria-busy");
		this.revision++;
		this.render();
	}

	/**
	 * Announce a change to the shelf, once.
	 *
	 * Guarded on the last message because `render` runs on every scroll page and every file
	 * change, and repeating an unchanged sentence is how a status region becomes noise.
	 */
	/**
	 * Dragging a file onto the shelf puts it on the shelf.
	 *
	 * The shortest path from "I have this PDF" to "I am reading it": before this, a file had to
	 * already be in the vault and then be found and right-clicked. Only files from outside
	 * Obsidian arrive with `dataTransfer.files`; a drag from the file explorer is already in the
	 * vault and can be opened the way it always could.
	 */
	private acceptDrops(root: HTMLElement): void {
		if (!this.deps.onAdd) return;

		const carriesFiles = (event: DragEvent): boolean =>
			Array.from(event.dataTransfer?.types ?? []).includes("Files");

		this.registerDomEvent(root, "dragenter", (event) => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			this.dragDepth++;
			root.addClass("is-drop-target");
		});

		this.registerDomEvent(root, "dragover", (event) => {
			if (!carriesFiles(event)) return;
			// Without this the browser opens the file instead, navigating away from the vault.
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});

		this.registerDomEvent(root, "dragleave", (event) => {
			if (!carriesFiles(event)) return;
			this.dragDepth = Math.max(0, this.dragDepth - 1);
			if (this.dragDepth === 0) root.removeClass("is-drop-target");
		});

		this.registerDomEvent(root, "drop", (event) => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			this.dragDepth = 0;
			root.removeClass("is-drop-target");

			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length > 0) void this.receive(files);
		});
	}

	/**
	 * Take what was dropped, then show it.
	 *
	 * Landing a document in the shelf and leaving the view where it was means dropping five
	 * files and seeing nothing happen. So the shelf moves to where they are: unread, newest
	 * first, scrolled to the top — which is where a thing you just added belongs.
	 */
	private async receive(files: readonly File[]): Promise<void> {
		if (!this.deps.onAdd) return;

		this.say(files.length === 1 ? "Adding 1 file…" : `Adding ${files.length} files…`);

		let result: AddedToLibrary;
		try {
			result = await this.deps.onAdd(files);
		} catch {
			this.say("Those files could not be added.");
			return;
		}

		if (result.added.length > 0) {
			this.query = "";
			this.searchEl.value = "";
			this.state = "unread";
			this.sort = "recent";
			this.sortEl.value = "recent";
			this.drawn = PAGE;
			this.contentEl.scrollTop = 0;
			this.render();
		}

		const added = result.added.length;
		const parts: string[] = [];
		if (added > 0) parts.push(`Added ${added} document${added === 1 ? "" : "s"} to unread.`);
		if (result.rejected.length > 0) {
			parts.push(`Reader cannot open ${result.rejected.join(", ")}.`);
		}
		if (parts.length === 0) parts.push("Nothing was added.");

		// Said rather than left to the row count, because the shelf may have been scrolled
		// somewhere else entirely when the drop landed.
		this.announced = "";
		this.say(parts.join(" "));
	}

	private say(message: string): void {
		if (!this.statusEl || message === this.announced) return;
		this.announced = message;
		this.statusEl.setText(message);
	}

	/** The entries currently on show, in order. Cached; see `cache`. */
	private shown(): LibraryEntry[] {
		const key = `${this.state}\u0000${this.query}\u0000${this.sort}\u0000${this.entries.size}\u0000${this.revision}`;
		if (this.cache?.key === key) return this.cache.rows;

		const all = [...this.entries.values()];
		const rows = sortEntries(filterEntries(ofState(all, this.state), this.query), this.sort);

		this.cache = { key, rows };
		return rows;
	}

	/**
	 * Bumped whenever an entry's contents change.
	 *
	 * The map's size does not move when a `.reader` is merely rewritten, which is the common
	 * case — a clip changes a document without adding one — so size alone cannot tell the
	 * cache it is stale.
	 */
	private revision = 0;

	/**
	 * Redraw, at most once a frame.
	 *
	 * `modify` fires for every `.reader` write, and a burst of them — an import, a sync — used
	 * to mean a burst of full redraws.
	 */
	private scheduleRender(): void {
		if (this.pendingRender !== undefined) return;

		this.pendingRender = window.requestAnimationFrame(() => {
			this.pendingRender = undefined;
			this.render();
		});
	}

	private pendingRender?: number;

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

		const counts = countsByState([...this.entries.values()]);
		this.say(
			`${shown.length} shown · ${counts.reading} reading, ${counts.unread} unread, ${counts.finished} finished`,
		);

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

			asButton(el, `${chip.label}: ${chip.count} documents`, () => {
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

		asButton(row, entry.title, () => this.deps.onOpen(entry.path));
		this.registerDomEvent(row, "contextmenu", (event) => {
			event.preventDefault();
			this.showRowMenu(event, entry);
		});
	}

	/** The usual right-click menu, with removal at the bottom behind a separator. */
	private showRowMenu(event: MouseEvent, entry: LibraryEntry): void {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Open in Reader")
				.setIcon("book-open")
				.onClick(() => this.deps.onOpen(entry.path)),
		);

		menu.addItem((item) =>
			item
				.setTitle("Open the note")
				.setIcon("file-text")
				.onClick(() => void this.app.workspace.openLinkText(entry.notePath, "", false)),
		);

		menu.addSeparator();

		/*
		 * Two removals, because the three files behind a row are not equally replaceable. The
		 * `.reader` is bookkeeping; the note may hold a semester of your writing.
		 */
		menu.addItem((item) =>
			item
				.setTitle("Remove from library")
				.setIcon("minus-circle")
				.onClick(() => void this.confirmRemoval(entry, false)),
		);

		menu.addItem((item) =>
			item
				.setTitle("Delete document and note…")
				.setIcon("trash-2")
				.onClick(() => void this.confirmRemoval(entry, true)),
		);

		menu.showAtMouseEvent(event);
	}

	private async confirmRemoval(entry: LibraryEntry, everything: boolean): Promise<void> {
		const plan = await this.planRemoval(entry);

		new ConfirmModal(this.app, {
			title: everything ? `Delete “${entry.title}”?` : `Remove “${entry.title}” from the library?`,
			body: `${describeRemoval(plan, everything)} Everything goes to trash, so this can be undone.`,
			confirmText: everything ? "Delete" : "Remove",
			onConfirm: () => void this.remove(plan, everything),
		}).open();
	}

	private async planRemoval(entry: LibraryEntry): Promise<RemovalPlan> {
		const note = this.app.vault.getAbstractFileByPath(entry.notePath);
		const written = note instanceof TFile ? writtenCharsIn(await this.app.vault.read(note)) : 0;

		return {
			readerPath: entry.path,
			notePath: note instanceof TFile ? entry.notePath : undefined,
			documentPath:
				this.app.vault.getAbstractFileByPath(entry.sourcePath) instanceof TFile
					? entry.sourcePath
					: undefined,
			writtenChars: written,
			clips: entry.clips,
		};
	}

	/**
	 * Trash, never delete.
	 *
	 * `trashFile` follows whatever the vault is configured for — system trash, the vault's own
	 * `.trash`, or permanent if that is what you chose. Choosing on your behalf is not this
	 * plugin's call, and a wrong answer here should be recoverable.
	 */
	private async remove(plan: RemovalPlan, everything: boolean): Promise<void> {
		const paths = [plan.readerPath, ...(everything ? [plan.notePath, plan.documentPath] : [])];
		let removed = 0;

		for (const path of paths) {
			if (!path) continue;

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				await this.app.fileManager.trashFile(file);
				removed++;
			} catch (error) {
				new Notice(`Reader: could not remove ${path}.`);
				console.error("[reader] removal failed", error);
			}
		}

		// The vault events rebuild the shelf, but say what happened rather than let a row
		// simply vanish.
		new Notice(`Reader: moved ${removed} file${removed === 1 ? "" : "s"} to trash.`);
	}

	protected override async onClose(): Promise<void> {
		if (this.pendingRender !== undefined) window.cancelAnimationFrame(this.pendingRender);
		this.contentEl.empty();
	}
}
