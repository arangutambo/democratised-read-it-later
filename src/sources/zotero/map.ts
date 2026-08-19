/**
 * Zotero rows → our data model. Pure: no database, no `obsidian`. See PLAN.md §3.1.
 *
 * The direction is deliberately one-way. PLAN.md §0.3: read Zotero, write nothing. These
 * annotations move out once; they never sync back, and Zotero keeps being the filing cabinet
 * for PDFs and the source of `library.bib`.
 */

import { ulid, type RandomSource } from "../../core/ids";
import type { Csl, CslName, Highlight, ImportResult, SourceRecord } from "../../core/types";

/** Zotero's annotation types. Only the text-bearing ones can become highlights. */
export const ANNOTATION_HIGHLIGHT = 1;
export const ANNOTATION_NOTE = 2;
export const ANNOTATION_IMAGE = 3;
export const ANNOTATION_INK = 4;
export const ANNOTATION_UNDERLINE = 5;

export interface ZoteroAnnotationRow {
	annotationID: number;
	itemKey: string | null;
	type: number;
	text: string | null;
	comment: string | null;
	color: string | null;
	pageLabel: string | null;
	sortIndex: string | null;
	position: string | null;
	parentItemID: number | null;
	attachmentKey: string | null;
	attachmentPath: string | null;
	attachmentLinkMode: number | null;
}

export interface ZoteroFieldRow {
	itemID: number;
	fieldName: string;
	value: string;
}

export interface ZoteroCreatorRow {
	itemID: number;
	firstName: string | null;
	lastName: string | null;
	fieldMode: number | null;
	creatorType: string | null;
}

export interface ZoteroItemRow {
	itemID: number;
	key: string;
	typeName: string;
}

/** Zotero item type → CSL type. Unmapped types pass through unchanged; CSL is open. */
const CSL_TYPES: Record<string, string> = {
	journalArticle: "article-journal",
	magazineArticle: "article-magazine",
	newspaperArticle: "article-newspaper",
	conferencePaper: "paper-conference",
	book: "book",
	bookSection: "chapter",
	thesis: "thesis",
	report: "report",
	webpage: "webpage",
	preprint: "article",
	manuscript: "manuscript",
	blogPost: "post-weblog",
};

export function cslTypeOf(zoteroType: string): string {
	return CSL_TYPES[zoteroType] ?? "document";
}

/**
 * Zotero stores dates as a multipart string — "2018-06-01 2018-06-01", sometimes with a
 * trailing part-code. Only the year is needed for CSL and for a citekey.
 */
export function yearFrom(date: string | null | undefined): number | undefined {
	if (!date) return undefined;
	const match = /\b(1\d{3}|20\d{2}|21\d{2})\b/.exec(date);
	return match ? Number(match[1]) : undefined;
}

/** `fieldMode` 1 means a single-field name — an institution, not a person. */
export function toCslName(row: ZoteroCreatorRow): CslName {
	if (row.fieldMode === 1 || !row.firstName) {
		return { literal: (row.lastName ?? "").trim() || (row.firstName ?? "").trim() };
	}
	return { family: (row.lastName ?? "").trim(), given: row.firstName.trim() };
}

export interface ZoteroPosition {
	pageIndex: number;
	rects: number[][];
}

/**
 * Zotero's `position` is JSON: `{"pageIndex":11,"rects":[[x1,y1,x2,y2],…]}`. That is exactly
 * the quadpoint anchor shape, so a PDF highlight survives the move with its geometry intact.
 */
export function parsePosition(position: string | null): ZoteroPosition | undefined {
	if (!position) return undefined;
	try {
		const parsed = JSON.parse(position) as Partial<ZoteroPosition>;
		if (typeof parsed.pageIndex !== "number" || !Array.isArray(parsed.rects)) return undefined;
		const rects = parsed.rects.filter((r): r is number[] => Array.isArray(r) && r.every((n) => typeof n === "number"));
		return { pageIndex: parsed.pageIndex, rects };
	} catch {
		return undefined;
	}
}

/**
 * Resolve an attachment to a file path.
 *
 * `storage:name.pdf` lives under `<dataDir>/storage/<attachmentKey>/name.pdf`. Link modes 2
 * and 3 are linked files whose path is already absolute (or `attachments:`-relative, which
 * we cannot resolve without Zotero's base-directory setting, so it is returned as-is).
 */
export function resolveAttachmentPath(
	row: Pick<ZoteroAnnotationRow, "attachmentPath" | "attachmentKey" | "attachmentLinkMode">,
	dataDir: string,
): string | undefined {
	const raw = row.attachmentPath;
	if (!raw) return undefined;

	if (raw.startsWith("storage:")) {
		if (!row.attachmentKey) return undefined;
		return `${dataDir}/storage/${row.attachmentKey}/${raw.slice("storage:".length)}`;
	}
	return raw;
}

export function buildCsl(
	item: ZoteroItemRow,
	fields: Map<string, string>,
	creators: readonly ZoteroCreatorRow[],
): Csl {
	const csl: Csl = { type: cslTypeOf(item.typeName) };

	const title = fields.get("title");
	if (title) csl.title = title;

	const authors = creators.filter((c) => c.creatorType === "author").map(toCslName);
	if (authors.length > 0) csl.author = authors;

	const year = yearFrom(fields.get("date"));
	if (year !== undefined) csl.issued = { "date-parts": [[year]] };

	const passthrough: Record<string, string> = {
		publicationTitle: "container-title",
		DOI: "DOI",
		ISBN: "ISBN",
		ISSN: "ISSN",
		url: "URL",
		volume: "volume",
		issue: "issue",
		pages: "page",
		publisher: "publisher",
		language: "language",
		abstractNote: "abstract",
	};

	for (const [zoteroField, cslField] of Object.entries(passthrough)) {
		const value = fields.get(zoteroField);
		if (value) csl[cslField] = value;
	}

	return csl;
}

export function mapAnnotation(
	row: ZoteroAnnotationRow,
	sourceId: string,
	now: number,
	random?: RandomSource,
): Highlight | null {
	// Image and ink annotations carry no text, so there is nothing to anchor or quote.
	if (row.type !== ANNOTATION_HIGHLIGHT && row.type !== ANNOTATION_UNDERLINE) return null;
	if (typeof row.text !== "string" || row.text.trim() === "") return null;

	const position = parsePosition(row.position);

	return {
		id: ulid(now, random),
		sourceId,
		sourceUuid: row.itemKey ?? undefined,
		text: row.text,
		colour: row.color ? `zotero:${row.color}` : undefined,
		note: row.comment?.trim() ? row.comment : undefined,
		created: new Date(now).toISOString(),
		state: "active",
		anchors: {
			// Zotero records no surrounding context, so there is none to invent. Re-anchoring
			// falls back to quad geometry and fuzzy matching for these.
			quote: { exact: row.text, prefix: "", suffix: "" },
			quad: position ? { page: position.pageIndex, rects: position.rects } : undefined,
		},
	};
}

export interface ZoteroBuildInput {
	items: readonly ZoteroItemRow[];
	annotations: readonly ZoteroAnnotationRow[];
	fields: readonly ZoteroFieldRow[];
	creators: readonly ZoteroCreatorRow[];
	/** Better BibTeX citation keys by itemID. */
	citekeys: ReadonlyMap<number, string>;
	dataDir: string;
	now?: number;
	random?: RandomSource;
}

export function buildImports(input: ZoteroBuildInput): ImportResult[] {
	const { items, annotations, fields, creators, citekeys, dataDir } = input;
	const now = input.now ?? Date.now();

	const fieldsByItem = new Map<number, Map<string, string>>();
	for (const row of fields) {
		let bucket = fieldsByItem.get(row.itemID);
		if (!bucket) fieldsByItem.set(row.itemID, (bucket = new Map<string, string>()));
		bucket.set(row.fieldName, row.value);
	}

	const creatorsByItem = new Map<number, ZoteroCreatorRow[]>();
	for (const row of creators) {
		const bucket = creatorsByItem.get(row.itemID);
		if (bucket) bucket.push(row);
		else creatorsByItem.set(row.itemID, [row]);
	}

	const byItem = new Map<number, ZoteroAnnotationRow[]>();
	for (const row of annotations) {
		if (row.parentItemID === null) continue;
		const bucket = byItem.get(row.parentItemID);
		if (bucket) bucket.push(row);
		else byItem.set(row.parentItemID, [row]);
	}

	const itemsById = new Map(items.map((i) => [i.itemID, i]));
	const results: ImportResult[] = [];

	for (const [itemID, rows] of byItem) {
		const item = itemsById.get(itemID);
		if (!item) continue;

		const itemFields = fieldsByItem.get(itemID) ?? new Map<string, string>();
		const csl = buildCsl(item, itemFields, creatorsByItem.get(itemID) ?? []);
		const warnings: string[] = [];

		// Zotero's own sort order, which follows reading order through the document.
		const ordered = [...rows].sort((a, b) => (a.sortIndex ?? "").localeCompare(b.sortIndex ?? ""));

		const highlights = ordered
			.map((row) => mapAnnotation(row, item.key, now, input.random))
			.filter((h): h is Highlight => h !== null);

		const skipped = rows.length - highlights.length;
		if (skipped > 0) {
			warnings.push(`${skipped} annotation(s) had no text (image or ink) and were skipped.`);
		}

		/*
		 * Better BibTeX's key wins whenever it exists.
		 *
		 * This is the point of syncing with Zotero rather than replacing it: BBT already
		 * generates library.bib, so using its key means a note here and a \cite{} in a
		 * manuscript are the same string. Minting our own would silently fork the two.
		 */
		const citekey = citekeys.get(itemID);
		if (!citekey) {
			warnings.push("No Better BibTeX citation key for this item; Reader generated one instead.");
		}

		const libraryPath = resolveAttachmentPath(ordered[0], dataDir);

		const source: SourceRecord = {
			id: item.key,
			sourceType: "paper",
			citekey: citekey ?? item.key.toLowerCase(),
			title: itemFields.get("title") ?? "Untitled",
			csl,
			libraryPath,
			deepLink: `zotero://select/library/items/${item.key}`,
			state: "inbox",
		};

		let confidence = 1;
		if (!csl.title) {
			warnings.push("No title recorded in Zotero.");
			confidence -= 0.4;
		}
		if (!csl.author) {
			warnings.push("No author recorded in Zotero.");
			confidence -= 0.2;
		}
		if (!libraryPath) {
			warnings.push("No file attached, so the note cannot link back to a PDF.");
			confidence -= 0.1;
		}

		results.push({
			source,
			highlights,
			confidence: Math.max(0, Math.round(confidence * 100) / 100),
			warnings,
		});
	}

	return results.sort((a, b) => a.source.title.localeCompare(b.source.title));
}
