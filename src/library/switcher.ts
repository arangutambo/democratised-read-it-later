/**
 * The library, as a quick switcher.
 *
 * The same gesture as opening a note — a keystroke, type a few letters, Enter — because a
 * shelf of 2,088 documents is not something you navigate by scrolling, and the pane is the
 * wrong tool when you already know what you want.
 *
 * Fuzzy rather than substring: the titles are long, sanitised, and carry a Readwise id on the
 * end, so "binf w2" ought to find one without being a prefix of anything.
 */

import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";

import { subtitleOf, type LibraryEntry } from "./model";

export class LibrarySwitcher extends FuzzySuggestModal<LibraryEntry> {
	private readonly entries: LibraryEntry[];
	private readonly onChoose: (entry: LibraryEntry) => void;

	constructor(app: App, entries: LibraryEntry[], onChoose: (entry: LibraryEntry) => void) {
		super(app);
		this.entries = entries;
		this.onChoose = onChoose;

		this.setPlaceholder(
			entries.length === 0 ? "No documents in the Reader library yet" : "Find a document…",
		);
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "open in Reader" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	getItems(): LibraryEntry[] {
		return this.entries;
	}

	/**
	 * What is matched against.
	 *
	 * The source path is included so a document can be found by the file it came from, which
	 * survives the note being renamed.
	 */
	getItemText(entry: LibraryEntry): string {
		return `${entry.title} ${entry.sourcePath}`;
	}

	/** Title on top, state and position underneath — the same line the shelf shows. */
	override renderSuggestion(match: FuzzyMatch<LibraryEntry>, el: HTMLElement): void {
		const entry = match.item;
		el.addClass("reader-switcher-row");

		el.createDiv({ cls: "reader-switcher-title", text: entry.title });

		const detail = [entry.state === "reading" ? "reading" : entry.state, subtitleOf(entry)]
			.filter((part) => part !== "")
			.join(" · ");

		el.createDiv({ cls: "reader-switcher-detail", text: detail });
	}

	onChooseItem(entry: LibraryEntry): void {
		this.onChoose(entry);
	}
}
