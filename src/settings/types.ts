import type { LogLevel } from "../core/log";

/** Bump when the shape below changes, and add a migration in `migrate.ts`. */
export const SETTINGS_SCHEMA_VERSION = 1;

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
	readerSkin: boolean;
	booksImport: boolean;
	pdfImport: boolean;
	slidesImport: boolean;
	webClip: boolean;
	zotero: boolean;
	ai: boolean;
}

export type FeatureKey = keyof FeatureFlags;

/** Subsystems that actually exist. Everything else is scaffolding for a later milestone. */
export const IMPLEMENTED_FEATURES: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
	"readerSkin",
	"booksImport",
]);

export const FEATURE_LABELS: Record<FeatureKey, { name: string; description: string }> = {
	readerSkin: {
		name: "Reader skin",
		description: "Render notes marked `reader: true` in a reading layout.",
	},
	booksImport: {
		name: "Apple Books import",
		description: "Import highlights and notes from Apple Books. Desktop only.",
	},
	pdfImport: {
		name: "PDF import",
		description: "Extract text and annotations from PDFs in your library.",
	},
	slidesImport: {
		name: "Slides import",
		description: "Turn slide decks into study notes, one heading per slide.",
	},
	webClip: {
		name: "Web clipping",
		description: "Receive clipped articles from the Safari extension.",
	},
	zotero: {
		name: "Zotero",
		description: "Read your Zotero library and migrate its annotations. Never writes to Zotero.",
	},
	ai: {
		name: "AI",
		description: "Metadata detection, vault auto-linking, and slide synthesis. Every output is a suggestion you accept.",
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
	logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	features: {
		readerSkin: true,
		booksImport: true,
		pdfImport: false,
		slidesImport: false,
		webClip: false,
		zotero: false,
		ai: false,
	},
	sourcesFolder: "Sources",
	assetsFolder: "Sources/_assets",
	libraryPath: "",
	progressFile: "Sources/.reader-progress.json",
	highlightColours: [],
	importConfidenceThreshold: 0.6,
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
