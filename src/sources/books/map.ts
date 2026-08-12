/**
 * Apple Books rows → our data model. Pure: no database, no `obsidian`, fully unit-testable.
 * See PLAN.md §3.1.
 */

import { baseCitekey, makeCitekey, ulid, type RandomSource } from "../../core/ids";
import type {
	Csl,
	CslName,
	Highlight,
	ImportResult,
	SourceRecord,
	TextQuoteSelector,
} from "../../core/types";

/** Core Data stores seconds since 2001-01-01T00:00:00Z. */
const CORE_DATA_EPOCH_OFFSET = 978_307_200;

/** Characters of context kept either side of a quote. DESIGN.md §5.1 argues for ~32. */
export const CONTEXT_LENGTH = 32;

export interface BooksAnnotationRow {
	assetId: string | null;
	selected: string | null;
	uuid: string | null;
	representative: string | null;
	note: string | null;
	style: number | null;
	cfi: string | null;
	chapter: string | null;
	created: number | null;
	modified: number | null;
	underline: number | null;
}

export interface BooksAssetRow {
	assetId: string | null;
	title: string | null;
	author: string | null;
	year: number | null;
	genre: string | null;
	language: string | null;
	pageCount: number | null;
	description: string | null;
	path: string | null;
}

export function coreDataToIso(seconds: number | null): string | undefined {
	if (seconds === null || !Number.isFinite(seconds)) return undefined;
	return new Date((seconds + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
}

/**
 * Build a W3C TextQuoteSelector from Apple's two text columns.
 *
 * `ZANNOTATIONREPRESENTATIVETEXT` holds the selection *plus* surrounding sentence context,
 * so locating the selection inside it yields genuine prefix and suffix rather than empty
 * strings. That is what lets a repeated phrase be re-anchored to the right occurrence later.
 */
export function deriveQuote(selected: string, representative: string | null): TextQuoteSelector {
	const exact = selected;
	if (!representative) return { exact, prefix: "", suffix: "" };

	let index = representative.indexOf(selected);
	let matched = selected;

	if (index === -1) {
		// Apple sometimes stores the selection trimmed differently from the context.
		const trimmed = selected.trim();
		index = representative.indexOf(trimmed);
		matched = trimmed;
	}

	if (index === -1) return { exact, prefix: "", suffix: "" };

	return {
		exact,
		prefix: representative.slice(Math.max(0, index - CONTEXT_LENGTH), index),
		suffix: representative.slice(index + matched.length, index + matched.length + CONTEXT_LENGTH),
	};
}

/** `ibooks://assetid/<asset>#<cfi>` — reopens Books at the highlight. */
export function deepLink(assetId: string, cfi?: string | null): string {
	const base = `ibooks://assetid/${assetId}`;
	return cfi ? `${base}#${cfi}` : base;
}

export function mapAnnotation(
	row: BooksAnnotationRow,
	sourceId: string,
	now: number = Date.now(),
	random?: RandomSource,
): Highlight | null {
	if (typeof row.selected !== "string" || row.selected.trim() === "") return null;

	const created = coreDataToIso(row.created);

	return {
		id: ulid(now, random),
		sourceId,
		sourceUuid: row.uuid ?? undefined,
		text: row.selected,
		colour: row.style === null ? undefined : `books:${row.style}`,
		note: row.note?.trim() ? row.note : undefined,
		created: created ?? new Date(now).toISOString(),
		modified: coreDataToIso(row.modified),
		chapter: row.chapter?.trim() ? row.chapter : undefined,
		state: "active",
		anchors: {
			quote: deriveQuote(row.selected, row.representative),
			cfi: row.cfi ?? undefined,
		},
	};
}

const AUTHOR_SEPARATOR = /\s+(?:&|and)\s+|;\s*/;
const CREDENTIALS = /^(?:m\.?d\.?|ph\.?d\.?|faclm|facln|frcp|jr\.?|sr\.?|i{1,3}|iv|dr\.?|prof\.?)$/i;

/**
 * Apple stores one display string, so parsing is best-effort by nature.
 *
 * A confidently structured name becomes `{family, given}`; anything ambiguous becomes a CSL
 * `literal`, which is valid CSL and renders correctly rather than inventing a wrong surname.
 */
export function parseAuthors(display: string | null): CslName[] {
	if (!display || display.trim() === "") return [];

	return display
		.split(AUTHOR_SEPARATOR)
		.map((raw) => raw.trim())
		.filter((raw) => raw !== "")
		.map((raw): CslName => {
			const stripped = raw
				.split(/\s+/)
				.filter((part) => !CREDENTIALS.test(part.replace(/,$/, "")))
				.join(" ")
				.replace(/,\s*$/, "")
				.trim();

			if (stripped.includes(",")) {
				const [family, given] = stripped.split(",", 2).map((s) => s.trim());
				if (family && given) return { family, given };
				if (family) return { family };
			}

			const words = stripped.split(/\s+/).filter(Boolean);
			if (words.length === 2) return { family: words[1], given: words[0] };

			return { literal: stripped || raw };
		});
}

export function mapAsset(row: BooksAssetRow, citekey?: string): SourceRecord {
	const title = row.title ?? "Untitled";
	const authors = parseAuthors(row.author);

	const csl: Csl = { type: "book", title };
	if (authors.length > 0) csl.author = authors;
	if (row.year) csl.issued = { "date-parts": [[row.year]] };
	if (row.language) csl.language = row.language;
	if (row.pageCount) csl.numberOfPages = row.pageCount;
	if (row.description?.trim()) csl.abstract = row.description;
	if (row.genre?.trim()) csl.genre = row.genre;

	const assetId = row.assetId ?? "";

	return {
		id: assetId,
		sourceType: "books",
		citekey: citekey ?? baseCitekey({ author: row.author ?? undefined, year: row.year ?? undefined, title }),
		title,
		csl,
		libraryPath: row.path ?? undefined,
		deepLink: assetId ? deepLink(assetId) : undefined,
		state: "inbox",
	};
}

/**
 * Confidence that this import is trustworthy, per PLAN.md §1 decision 9.
 * Anything below the configured threshold is marked `needs-review` rather than trusted.
 */
export function assessConfidence(source: SourceRecord, highlights: Highlight[]): { confidence: number; warnings: string[] } {
	const warnings: string[] = [];
	let confidence = 1;

	if (source.title === "Untitled") {
		warnings.push("No title in the Books library for this asset.");
		confidence -= 0.4;
	}
	if (!source.csl.author) {
		warnings.push("No author recorded, so the citekey is weaker than usual.");
		confidence -= 0.2;
	}
	if (!source.csl.issued) {
		warnings.push("No publication year recorded.");
		confidence -= 0.1;
	}

	const withoutContext = highlights.filter((h) => h.anchors.quote.prefix === "" && h.anchors.quote.suffix === "");
	if (highlights.length > 0 && withoutContext.length / highlights.length > 0.5) {
		warnings.push(
			`${withoutContext.length} of ${highlights.length} highlights have no surrounding context, ` +
				`so re-anchoring them later will be less reliable.`,
		);
		confidence -= 0.2;
	}

	return { confidence: Math.max(0, Math.round(confidence * 100) / 100), warnings };
}

export interface BuildOptions {
	now?: number;
	random?: RandomSource;
	/**
	 * Citekeys already assigned to these assets by a previous import, keyed by asset id.
	 *
	 * PLAN.md §1: citekeys are generated once and stored forever. Re-importing must reuse
	 * the existing key even if the metadata has since changed, or every draft citing it
	 * breaks silently.
	 */
	existingCitekeys?: ReadonlyMap<string, string>;
}

/**
 * Group annotations under their books and produce one import per annotated asset.
 *
 * Books with no highlights are skipped — a 384-item library where 23 are annotated should
 * not produce 361 empty notes.
 */
export function buildImports(
	assets: readonly BooksAssetRow[],
	annotations: readonly BooksAnnotationRow[],
	options: BuildOptions = {},
): ImportResult[] {
	const { now = Date.now(), random, existingCitekeys = new Map<string, string>() } = options;

	const byAsset = new Map<string, BooksAnnotationRow[]>();
	let orphaned = 0;
	for (const row of annotations) {
		if (!row.assetId) {
			orphaned++;
			continue;
		}
		const bucket = byAsset.get(row.assetId);
		if (bucket) bucket.push(row);
		else byAsset.set(row.assetId, [row]);
	}

	const assetsById = new Map<string, BooksAssetRow>();
	for (const asset of assets) {
		if (asset.assetId) assetsById.set(asset.assetId, asset);
	}

	const taken = new Set<string>(existingCitekeys.values());
	const results: ImportResult[] = [];

	for (const [assetId, rows] of byAsset) {
		const asset: BooksAssetRow = assetsById.get(assetId) ?? {
			assetId,
			title: null,
			author: null,
			year: null,
			genre: null,
			language: null,
			pageCount: null,
			description: null,
			path: null,
		};

		const previous = existingCitekeys.get(assetId);
		const citekey =
			previous ??
			makeCitekey(
				{ author: asset.author ?? undefined, year: asset.year ?? undefined, title: asset.title ?? "Untitled" },
				taken,
			);
		taken.add(citekey);

		const source = mapAsset(asset, citekey);
		const highlights = rows
			.map((row) => mapAnnotation(row, assetId, now, random))
			.filter((h): h is Highlight => h !== null);

		const { confidence, warnings } = assessConfidence(source, highlights);

		// Nothing is dropped silently. SQLite's trim() strips only spaces while JavaScript's
		// strips newlines and tabs too, so rows that look non-empty to the query can still be
		// empty here — one such row exists in the real library.
		const skipped = rows.length - highlights.length;
		if (skipped > 0) {
			warnings.push(`${skipped} row(s) held no highlight text and were skipped.`);
		}

		if (!assetsById.has(assetId)) {
			warnings.push(
				`This book is not in the Books library any more, so only its highlights survive — ` +
					`title and author are unknown.`,
			);
		}

		results.push({ source, highlights, confidence, warnings });
	}

	if (orphaned > 0 && results.length > 0) {
		results[0].warnings.push(`${orphaned} highlight(s) had no book attached and were skipped.`);
	}

	return results.sort((a, b) => a.source.title.localeCompare(b.source.title));
}
