/**
 * Apple Books column probing.
 *
 * DESIGN.md §8: "degrade gracefully when the schema changes — detect missing columns and
 * report, don't crash." Apple's schema is undocumented and moves between OS releases, so
 * every optional column is selected as NULL when absent. Downstream mapping then sees one
 * uniform row shape and never has to know which macOS version produced it.
 *
 * Columns are aliased to plain names here so `map.ts` is written against our vocabulary
 * rather than Apple's, which is also what makes it testable without a database.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

export interface ColumnSpec {
	column: string;
	alias: string;
	/** Absent required columns mean the import cannot proceed at all. */
	required?: boolean;
}

export const ANNOTATION_TABLE = "ZAEANNOTATION";
export const ASSET_TABLE = "ZBKLIBRARYASSET";

export const ANNOTATION_SPEC: readonly ColumnSpec[] = [
	{ column: "ZANNOTATIONASSETID", alias: "assetId", required: true },
	{ column: "ZANNOTATIONSELECTEDTEXT", alias: "selected", required: true },
	{ column: "ZANNOTATIONUUID", alias: "uuid" },
	{ column: "ZANNOTATIONREPRESENTATIVETEXT", alias: "representative" },
	{ column: "ZANNOTATIONNOTE", alias: "note" },
	{ column: "ZANNOTATIONSTYLE", alias: "style" },
	{ column: "ZANNOTATIONLOCATION", alias: "cfi" },
	{ column: "ZFUTUREPROOFING5", alias: "chapter" },
	{ column: "ZANNOTATIONCREATIONDATE", alias: "created" },
	{ column: "ZANNOTATIONMODIFICATIONDATE", alias: "modified" },
	{ column: "ZANNOTATIONISUNDERLINE", alias: "underline" },
];

export const ASSET_SPEC: readonly ColumnSpec[] = [
	{ column: "ZASSETID", alias: "assetId", required: true },
	{ column: "ZTITLE", alias: "title", required: true },
	{ column: "ZAUTHOR", alias: "author" },
	{ column: "ZYEAR", alias: "year" },
	{ column: "ZGENRE", alias: "genre" },
	{ column: "ZLANGUAGE", alias: "language" },
	{ column: "ZPAGECOUNT", alias: "pageCount" },
	{ column: "ZBOOKDESCRIPTION", alias: "description" },
	{ column: "ZPATH", alias: "path" },
];

export interface SelectPlan {
	/** Comma-separated select list, with `NULL as alias` standing in for absent columns. */
	selectList: string;
	/** Optional columns not present in this database. Reported, not fatal. */
	missing: string[];
	/** Required columns not present. Any entry here means the import must abort. */
	fatal: string[];
}

export function planSelect(spec: readonly ColumnSpec[], available: ReadonlySet<string>): SelectPlan {
	const parts: string[] = [];
	const missing: string[] = [];
	const fatal: string[] = [];

	for (const { column, alias, required } of spec) {
		if (available.has(column)) {
			parts.push(`${column} as ${alias}`);
			continue;
		}
		if (required) fatal.push(column);
		else missing.push(column);
		parts.push(`NULL as ${alias}`);
	}

	return { selectList: parts.join(", "), missing, fatal };
}

/**
 * Whether a row represents a live highlight worth importing.
 *
 * `ZANNOTATIONDELETED` is filtered in SQL rather than here, but selected text can also be
 * null or whitespace for bookmarks, which are rows in the same table and are not highlights.
 */
export function isImportableSelection(selected: unknown): selected is string {
	return typeof selected === "string" && selected.trim() !== "";
}
