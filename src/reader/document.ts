/**
 * The `.reader` file: what is being read, and where every mark on it came from.
 *
 * It holds **no content you would ever read or cite**. Quotes and images live in the note;
 * this is the annotation overlay plus the provenance the note is not allowed to show. That
 * asymmetry is the whole safety story — losing this file costs marks and back-navigation,
 * never words, which is what makes "the note wins" a safe rule rather than a destructive one.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { Locator, SurfaceKind } from "../capture/types";

export const READER_DOCUMENT_VERSION = 1;

export type SourceKind = "pdf" | "epub" | "video" | "html";

export interface ReaderView {
	/** Page number, spine index, or 0 for a continuous surface. */
	surface: number;
	zoom: number;
	/** Fraction of the current surface scrolled past, 0–1. */
	scroll: number;
}

export interface ReaderDocument {
	version: number;
	source: {
		/**
		 * Where the document lives. Vault-relative when inside, absolute when outside — Reader
		 * renders PDFs itself rather than relying on Obsidian's viewer, so a document does not
		 * have to be in the vault to be readable.
		 */
		path: string;
		kind: SourceKind;
	};
	/** Vault-relative path to the companion note. */
	notePath: string;
	/** Clip id → where it came from. Keyed by the same id the note carries as `^hl-<id>`. */
	clips: Record<string, Locator>;
	view: ReaderView;
}

export class ReaderDocumentError extends Error {}

export function createDocument(
	sourcePath: string,
	kind: SourceKind,
	notePath: string,
): ReaderDocument {
	return {
		version: READER_DOCUMENT_VERSION,
		source: { path: sourcePath, kind },
		notePath,
		clips: {},
		view: { surface: 1, zoom: 1, scroll: 0 },
	};
}

export function serialise(doc: ReaderDocument): string {
	// Two-space indent and a trailing newline: this file sits in a vault under version
	// control and under Obsidian Sync, and a one-line blob makes every change a whole-file
	// diff. Key order is stable so a re-save with no changes produces no diff at all.
	return `${JSON.stringify(doc, null, 2)}\n`;
}

const SURFACE_KINDS: readonly SurfaceKind[] = [
	"pdf-page",
	"video-frame",
	"epub-section",
	"html-article",
];

const SOURCE_KINDS: readonly SourceKind[] = ["pdf", "epub", "video", "html"];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A locator, or undefined if it is not usable.
 *
 * Dropping a malformed locator is deliberate. The clip's content is in the note and is
 * unaffected; all that is lost is the mark and the ability to jump back. Throwing here would
 * make one bad entry take the whole document down with it.
 */
function parseLocator(value: unknown): Locator | undefined {
	if (!isObject(value)) return undefined;

	const surface = value.surface;
	if (!isObject(surface)) return undefined;
	if (!SURFACE_KINDS.includes(surface.kind as SurfaceKind)) return undefined;
	if (typeof surface.index !== "number" || !Number.isFinite(surface.index)) return undefined;

	const out: Locator = { surface: { kind: surface.kind as SurfaceKind, index: surface.index } };

	if (Array.isArray(value.rect) && value.rect.length === 4) {
		const rect = value.rect as unknown[];
		if (rect.every((n) => typeof n === "number" && Number.isFinite(n))) {
			out.rect = [rect[0], rect[1], rect[2], rect[3]] as Locator["rect"];
		}
	}

	if (typeof value.time === "number" && Number.isFinite(value.time)) out.time = value.time;
	if (typeof value.cfi === "string" && value.cfi !== "") out.cfi = value.cfi;

	const quote = value.quote;
	if (isObject(quote) && typeof quote.exact === "string") {
		out.quote = {
			exact: quote.exact,
			prefix: typeof quote.prefix === "string" ? quote.prefix : "",
			suffix: typeof quote.suffix === "string" ? quote.suffix : "",
		};
	}

	return out;
}

export interface ParseResult {
	document: ReaderDocument;
	/** Surfaced, never swallowed. */
	warnings: string[];
}

export function parseDocument(raw: string): ParseResult {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new ReaderDocumentError("This .reader file is not valid JSON.");
	}

	if (!isObject(data)) throw new ReaderDocumentError("This .reader file is not an object.");

	const source = isObject(data.source) ? data.source : undefined;
	const path = typeof source?.path === "string" ? source.path : "";
	if (path === "") throw new ReaderDocumentError("This .reader file names no document.");

	const warnings: string[] = [];
	const version = asFiniteNumber(data.version, 0);
	if (version > READER_DOCUMENT_VERSION) {
		warnings.push(
			`Written by a newer version of Reader (format ${version}). Unknown fields are preserved.`,
		);
	}

	const kind = SOURCE_KINDS.includes(source?.kind as SourceKind)
		? (source?.kind as SourceKind)
		: "pdf";

	const clips: Record<string, Locator> = {};
	let dropped = 0;
	if (isObject(data.clips)) {
		for (const [id, value] of Object.entries(data.clips)) {
			const locator = parseLocator(value);
			if (locator) clips[id] = locator;
			else dropped++;
		}
	}
	if (dropped > 0) {
		warnings.push(`${dropped} mark(s) could not be read and will not be drawn on the document.`);
	}

	const view = isObject(data.view) ? data.view : {};

	return {
		document: {
			...data,
			version: READER_DOCUMENT_VERSION,
			source: { ...source, path, kind },
			notePath: typeof data.notePath === "string" ? data.notePath : "",
			clips,
			view: {
				surface: Math.max(1, Math.round(asFiniteNumber(view.surface, 1))),
				zoom: Math.min(8, Math.max(0.1, asFiniteNumber(view.zoom, 1))),
				scroll: Math.min(1, Math.max(0, asFiniteNumber(view.scroll, 0))),
			},
		} as ReaderDocument,
		warnings,
	};
}

/** `^hl-<id>` as the note carries it. Case-insensitive: the file may have been hand-edited. */
const BLOCK_ID = /\^hl-([0-9a-zA-Z]+)/g;

/** Every clip id the note still refers to. */
export function blockIdsIn(noteBody: string): Set<string> {
	const out = new Set<string>();
	for (const match of noteBody.matchAll(BLOCK_ID)) out.add(match[1].toLowerCase());
	return out;
}

export interface Reconciliation {
	document: ReaderDocument;
	/** Locators dropped because the note no longer mentions them. */
	dropped: string[];
	/** Block ids in the note with no locator — ordinary content, drawn nowhere. */
	unanchored: string[];
	changed: boolean;
}

/**
 * Bring `.reader` into line with the note. **The note is authoritative for existence.**
 *
 * | note | .reader | result |
 * | --- | --- | --- |
 * | has the block id | has the locator | the mark is drawn |
 * | **no** block id | has the locator | the locator is dropped, permanently |
 * | has the block id | no locator | ordinary content; nothing is drawn |
 *
 * Deleting a bullet therefore removes the mark, and nothing ever comes back. The alternative
 * — regenerating the bullet from `.reader` — would step on the prose indented underneath it,
 * and a note tool that resurrects deleted things is worse than one that forgets.
 *
 * Nothing is written back into the note here. Reconciliation only ever narrows `.reader`.
 */
export function reconcile(doc: ReaderDocument, noteBody: string): Reconciliation {
	const present = blockIdsIn(noteBody);

	const clips: Record<string, Locator> = {};
	const dropped: string[] = [];

	for (const [id, locator] of Object.entries(doc.clips)) {
		if (present.has(id.toLowerCase())) clips[id] = locator;
		else dropped.push(id);
	}

	const known = new Set(Object.keys(doc.clips).map((id) => id.toLowerCase()));
	const unanchored = [...present].filter((id) => !known.has(id));

	return {
		document: dropped.length === 0 ? doc : { ...doc, clips },
		dropped,
		unanchored,
		changed: dropped.length > 0,
	};
}
