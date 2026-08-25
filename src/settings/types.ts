import type { LogLevel } from "../core/log";

/** Bump when the shape below changes, and add a migration in `migrate.ts`. */
export const SETTINGS_SCHEMA_VERSION = 2;

/**
 * A highlight colour and what it means.
 *
 * Meaning is user-defined and empty by default. The design document assumed an existing
 * key-claim / to-read / disagreement / method taxonomy, but the databases disagree: 84% of
 * Apple Books highlights use the default yellow and Zotero holds seven annotations in total.
 * There is no established practice to preserve, and this ships publicly, so no taxonomy is
 * imposed. `SUGGESTED_COLOURS` is offered behind a button and never applied automatically.
 */
export interface HighlightColour {
	/** Stable identifier; referenced by highlights, so never regenerate it. */
	id: string;
	/** What this colour means to the user, e.g. "Key claim". Free text. */
	name: string;
	/** CSS colour, or a highlightr-plugin class name. */
	css: string;
	/**
	 * Raw source values that map onto this colour, namespaced by source.
	 * Apple Books styles are integers: `books:1` green, `books:2` blue, `books:3` yellow,
	 * `books:4` pink, `books:5` purple.
	 */
	sourceKeys: string[];
}

export interface FeatureFlags {
	/** The Reader view itself: opening documents and clipping from them. */
	reader: boolean;
	readerSkin: boolean;
	booksImport: boolean;
	readwiseImport: boolean;
	webClip: boolean;
	zotero: boolean;
	ai: boolean;
}

export type FeatureKey = keyof FeatureFlags;

/** Subsystems that actually exist. Everything else is scaffolding for a later milestone. */
export const IMPLEMENTED_FEATURES: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
	"reader",
	"readerSkin",
	"booksImport",
	"readwiseImport",
	"zotero",
	"ai",
]);

export const FEATURE_LABELS: Record<FeatureKey, { name: string; description: string }> = {
	reader: {
		name: "Reader",
		description:
			"Read documents in Obsidian and clip from them — a passage becomes a quote, a dragged " +
			"box becomes an image, and you write underneath in the note beside it.",
	},
	readerSkin: {
		name: "Reader skin",
		description: "Render notes marked `reader: true` in a reading layout.",
	},
	booksImport: {
		name: "Apple Books import",
		description: "Import highlights and notes from Apple Books. Desktop only.",
	},
	webClip: {
		name: "Web clipping",
		description: "Receive clipped articles from the Safari extension.",
	},
	readwiseImport: {
		name: "Readwise import",
		description:
			"Turn a Readwise export — the CSV and the uploaded-files zip — into notes you own, " +
			"with the PDFs and EPUBs openable in Reader. No token, no live subscription.",
	},
	zotero: {
		name: "Zotero",
		description:
			"Migrate highlights out of Zotero into notes, using Better BibTeX's own citekeys so " +
			"your notes and your .bib agree. Reads only; never writes to Zotero.",
	},
	ai: {
		name: "AI",
		description:
			"Transcribe a clipped region — an equation to LaTeX, a table to markdown — with x. " +
			"Needs an Anthropic API key, and the result is always shown to you before anything is written.",
	},
};

export interface ReaderSettings {
	schemaVersion: number;
	features: FeatureFlags;
	/** Vault-relative folder for imported source notes. */
	sourcesFolder: string;
	/** Vault-relative folder for cited images. Only assets you actually reference land here. */
	assetsFolder: string;
	/**
	 * Vault-relative folder documents are copied into when they arrive from outside.
	 *
	 * Reader renders PDFs itself rather than relying on Obsidian's viewer, so a document no
	 * longer has to be inside the vault to be readable. This is a default home, not a
	 * requirement.
	 */
	decksFolder: string;
	/**
	 * Resolution for clipped regions and pages, in DPI.
	 *
	 * 150 puts a region at roughly 80–250 KB and a full page at 200–450 KB, in line with the
	 * PNGs already in a typical vault. Lower saves space at the cost of small type in dense
	 * slides being unreadable when you zoom, which defeats the purpose of clipping it.
	 */
	clipDpi: number;
	/**
	 * Blank space left under each clip sent to Excalidraw, as a percentage of the clip's own
	 * height. Proportional because the room a clip needs scales with it: a whole exam page
	 * needs more working underneath than a one-line definition.
	 */
	excalidrawWorkingRoom: number;
	/** Zotero's data directory. Blank uses ~/Zotero. */
	zoteroDataDir: string;
	/**
	 * Anthropic API key, for transcribing a clipped region.
	 *
	 * Stored in `data.json`, in plain text, inside the vault — which means it syncs wherever
	 * the vault syncs and sits in whatever backs the vault up. That is a real exposure, not a
	 * formality, so it is empty by default and the AI feature is off by default: nothing here
	 * reaches the network until you have made both choices deliberately.
	 */
	anthropicApiKey: string;
	/**
	 * Absolute path to the external library holding originals — EPUBs, full PDFs, decks.
	 * Deliberately outside the vault: this vault is already 2.7 GB.
	 */
	libraryPath: string;
	/**
	 * Vault-relative path to the reading-progress file. One debounced file rather than
	 * per-note frontmatter, so progress never rewrites notes or churns Obsidian Sync.
	 */
	progressFile: string;
	highlightColours: HighlightColour[];
	/** Imports below this confidence are marked `needs-review` rather than trusted. 0–1. */
	importConfidenceThreshold: number;
	/**
	 * Whether removing a document from the library also trashes its file and its note.
	 *
	 * Off by default, because the three files behind one row are not equally replaceable and
	 * the plain meaning of deleting a `.reader` is "take this off the shelf" — the PDF may be
	 * your only copy and the note may hold a term of your writing. On, it means what someone
	 * who is watching their disk fill up expects: the row goes, and so does everything behind
	 * it. Everything is trashed rather than erased either way.
	 *
	 * Worth knowing before switching it on: a deletion arriving from Obsidian Sync is a
	 * deletion, so a document removed on another device takes its file and note here too.
	 */
	deleteEverything: boolean;
	logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	features: {
		reader: true,
		readerSkin: true,
		booksImport: true,
		readwiseImport: true,
		webClip: false,
		zotero: true,
		ai: false,
	},
	sourcesFolder: "Sources",
	assetsFolder: "Sources/_assets",
	decksFolder: "Sources/_decks",
	clipDpi: 150,
	excalidrawWorkingRoom: 66,
	zoteroDataDir: "",
	anthropicApiKey: "",
	libraryPath: "",
	progressFile: "Sources/.reader-progress.json",
	highlightColours: [],
	importConfidenceThreshold: 0.6,
	deleteEverything: false,
	logLevel: "warn",
};

/** Offered as a starting point behind a button. Never applied without an explicit click. */
export const SUGGESTED_COLOURS: readonly HighlightColour[] = [
	{ id: "key-claim", name: "Key claim", css: "#ffd60a", sourceKeys: ["books:3"] },
	{ id: "method", name: "Method", css: "#5ac8fa", sourceKeys: ["books:2"] },
	{ id: "disagreement", name: "Disagreement", css: "#ff6b6b", sourceKeys: ["books:4"] },
	{ id: "follow-up", name: "Follow up", css: "#bf5af2", sourceKeys: ["books:5"] },
	{ id: "context", name: "Context", css: "#32d74b", sourceKeys: ["books:1"] },
];
