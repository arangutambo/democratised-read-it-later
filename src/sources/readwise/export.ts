/**
 * Leaving Readwise, from files you already have.
 *
 * The point of this plugin is to not need Readwise, so the migration is deliberately built on
 * its **export**, not its API: a CSV of your library and a zip of the documents themselves,
 * both downloadable from your account, both usable offline, neither needing a token or a
 * subscription that is still live. Once this has run you can cancel and lose nothing.
 *
 * What the export does *not* contain is the highlights you made inside Readwise — those are
 * behind the v2 API. That is the only thing a token buys, and it is a separate, optional step.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** A row of the Reader export CSV, as Readwise writes it. */
export interface ExportRow {
	Title: string;
	URL: string;
	ID: string;
	"Document tags": string;
	"Saved date": string;
	"Reading progress": string;
	Location: string;
	Seen: string;
}

export type ReaderLocation = "new" | "later" | "shortlist" | "archive" | "feed";

export interface ReadwiseDocument {
	id: string;
	title: string;
	url: string;
	tags: string[];
	saved?: string;
	/** 0–1. Readwise records this per document and it maps onto the library pane directly. */
	progress: number;
	location: ReaderLocation;
	seen: boolean;
}

/**
 * Parse a CSV.
 *
 * Written out because the fields contain commas, quotes and newlines — article titles are
 * arbitrary text — and splitting on commas produces a file that imports almost correctly,
 * which is the worst outcome. This is the whole of RFC 4180's reading half.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;

	// A BOM is common in exports and becomes part of the first column name otherwise.
	const input = text.replace(/^\uFEFF/, "");

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (quoted) {
			if (ch !== '"') {
				field += ch;
			} else if (input[i + 1] === '"') {
				// A doubled quote inside a quoted field is one literal quote.
				field += '"';
				i++;
			} else {
				quoted = false;
			}
			continue;
		}

		if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			// Readwise writes CRLF; consuming the pair avoids an empty row between every line.
			if (ch === "\r" && input[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += ch;
		}
	}

	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

const LOCATIONS: ReaderLocation[] = ["new", "later", "shortlist", "archive", "feed"];

/** The library, as documents. */
export function parseExport(csv: string): ReadwiseDocument[] {
	const rows = parseCsv(csv);
	if (rows.length < 2) return [];

	const header = rows[0].map((name) => name.trim());
	const out: ReadwiseDocument[] = [];

	for (const row of rows.slice(1)) {
		// A short row is a truncated export, not a reason to abandon the rest.
		if (row.length < header.length) continue;

		const value = (name: string): string => row[header.indexOf(name)] ?? "";
		const id = value("ID").trim();
		if (id === "") continue;

		const location = value("Location").trim().toLowerCase();

		out.push({
			id,
			title: value("Title").trim(),
			url: value("URL").trim(),
			tags: parseTags(value("Document tags")),
			saved: value("Saved date").trim() || undefined,
			progress: parseProgress(value("Reading progress")),
			location: (LOCATIONS as string[]).includes(location) ? (location as ReaderLocation) : "new",
			seen: value("Seen").trim().toLowerCase() === "true",
		});
	}

	return out;
}

/** Readwise writes tags as a Python list literal: `['youtube', 'favorite']`. */
export function parseTags(raw: string): string[] {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "[]") return [];

	return trimmed
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((tag) => tag.trim().replace(/^['"]|['"]$/g, ""))
		.filter((tag) => tag !== "");
}

function parseProgress(raw: string): number {
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value)) return 0;
	// Some rows are a fraction and some a percentage; both mean the same thing.
	return Math.min(1, Math.max(0, value > 1 ? value / 100 : value));
}

/**
 * Which documents are worth importing.
 *
 * `feed` is an RSS stream you skim, not a library you keep — 3,443 of 5,542 rows in a real
 * export. Bringing it in wholesale is v1's bulk-extraction mistake at that scale, so it is
 * excluded unless asked for.
 */
export function importable(
	documents: readonly ReadwiseDocument[],
	options: { includeFeed?: boolean; includeUnseen?: boolean } = {},
): ReadwiseDocument[] {
	return documents.filter((doc) => {
		if (!options.includeFeed && doc.location === "feed") return false;
		// Something saved and never opened is still a deliberate save; only the feed is noise.
		if (options.includeUnseen === false && !doc.seen) return false;
		return true;
	});
}

/**
 * The file in the uploaded-files zip that holds this document.
 *
 * Readwise names them `<title> (<id>).<ext>`, with the title sanitised for a filesystem — so
 * the id is the only reliable key, and it is what this matches on.
 */
export function matchFilename(files: readonly string[], id: string): string | undefined {
	const needle = `(${id})`;
	return files.find((name) => name.includes(needle));
}

/** Readwise's reading location, mapped onto Reader's own states. */
export function stateFor(location: ReaderLocation): "inbox" | "reading" | "archived" | "feed" {
	switch (location) {
		case "archive":
			return "archived";
		case "shortlist":
			return "reading";
		case "feed":
			return "feed";
		default:
			return "inbox";
	}
}
