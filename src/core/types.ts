/** Core data model. No `obsidian` import — see PLAN.md §3.1. */

export type SourceType = "web" | "books" | "pdf" | "slides" | "epub" | "paper";

export type SourceState = "inbox" | "reading" | "done" | "archived" | "needs-review";

export type HighlightState = "active" | "orphaned";

/**
 * W3C Web Annotation TextQuoteSelector.
 *
 * `exact` alone cannot place a quote — "however" appears forty times in a paper. The
 * surrounding context is what disambiguates, which is why prefix and suffix are required
 * fields rather than optional ones.
 */
export interface TextQuoteSelector {
	exact: string;
	prefix: string;
	suffix: string;
}

export interface HighlightAnchors {
	quote: TextQuoteSelector;
	/** EPUB canonical fragment identifier, when the source provides one. */
	cfi?: string;
	quad?: { page: number; rects: number[][] };
	/** Last-resort character offsets. Broken by any edit; tried only after everything else. */
	offset?: { start: number; end: number };
}

export interface Highlight {
	/** ULID. Becomes the `^hl-…` block id, so it is generated once and never recomputed. */
	id: string;
	sourceId: string;
	/**
	 * Stable identifier from the originating system (Apple's ZANNOTATIONUUID, Zotero's key).
	 * Re-import matches on this so our own ids survive, making imports idempotent.
	 */
	sourceUuid?: string;
	text: string;
	/** Raw source colour key, namespaced: `books:3`. Meaning is resolved via settings. */
	colour?: string;
	note?: string;
	/** ISO 8601. */
	created: string;
	modified?: string;
	chapter?: string;
	state: HighlightState;
	anchors: HighlightAnchors;
}

export interface CslName {
	family?: string;
	given?: string;
	literal?: string;
}

/** CSL-JSON. Deliberately open — CSL has many fields and we pass through what we find. */
export interface Csl {
	type: string;
	title?: string;
	author?: CslName[];
	issued?: { "date-parts": number[][] };
	"container-title"?: string;
	publisher?: string;
	language?: string;
	URL?: string;
	DOI?: string;
	ISBN?: string;
	abstract?: string;
	numberOfPages?: number;
	[key: string]: unknown;
}

export interface SourceRecord {
	/** Stable id of the document within its source system. */
	id: string;
	sourceType: SourceType;
	/** Deterministic, generated once, stored forever. Never recomputed from mutable metadata. */
	citekey: string;
	title: string;
	csl: Csl;
	/** Absolute path to the original, outside the vault. */
	libraryPath?: string;
	/** e.g. `ibooks://assetid/…`. Opens the source at the right place. */
	deepLink?: string;
	state: SourceState;
}

export interface ImportResult {
	source: SourceRecord;
	highlights: Highlight[];
	/** 0–1. Below the configured threshold the note is marked `needs-review`. */
	confidence: number;
	/** Surfaced to the user, never swallowed. */
	warnings: string[];
}
