/**
 * Finding text across a document.
 *
 * The matching is pure and the index is built incrementally, because extracting text from a
 * 315-page workbook is a worker round trip per page and doing it all at once would freeze the
 * view for seconds. Pages are indexed as they are asked for, cached, and the search reports
 * what it has found so far while it keeps going.
 *
 * Matching is deliberately forgiving in the two ways a PDF is deliberately awkward: case, and
 * whitespace. A search for "dot product" must find "Dot  product" split across a line break,
 * because that is what the text layer actually contains.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

export interface SearchHit {
	page: number;
	/** Where the match starts in the page's normalised text. */
	at: number;
	/** The matched text, as the page spells it. */
	text: string;
	/** Surrounding words, for a result list. */
	snippet: string;
}

/** Words either side of a hit in its snippet. Enough to recognise the passage. */
const CONTEXT = 40;

/**
 * Collapse whitespace and case so a query matches text the PDF broke across lines.
 *
 * The mapping back to original offsets is not kept: a hit reports where it starts in the
 * *normalised* text, which is what the caller searches again to highlight. Keeping a full
 * index map per page was measured as the quadratic step that made v1's anchoring take 130
 * seconds, and nothing here needs that precision.
 */
export function normalise(text: string): string {
	return text.replace(/\s+/g, " ").toLowerCase();
}

/** Every occurrence of `query` in one page's text. */
export function findInPage(pageText: string, page: number, query: string): SearchHit[] {
	const needle = normalise(query).trim();
	if (needle === "") return [];

	const haystack = normalise(pageText);
	const out: SearchHit[] = [];

	let at = haystack.indexOf(needle);
	while (at !== -1) {
		out.push({
			page,
			at,
			text: pageText.replace(/\s+/g, " ").slice(at, at + needle.length),
			snippet: snippetAround(pageText.replace(/\s+/g, " "), at, needle.length),
		});

		// Overlapping matches are not useful — step past this one.
		at = haystack.indexOf(needle, at + needle.length);

		// A pathological query on a dense page should not produce thousands of hits.
		if (out.length >= 50) break;
	}

	return out;
}

function snippetAround(text: string, at: number, length: number): string {
	const from = Math.max(0, at - CONTEXT);
	const to = Math.min(text.length, at + length + CONTEXT);

	const lead = from > 0 ? "…" : "";
	const tail = to < text.length ? "…" : "";
	return `${lead}${text.slice(from, to).trim()}${tail}`;
}

export interface SearchProgress {
	/** Pages indexed so far. */
	done: number;
	total: number;
	hits: SearchHit[];
}

/**
 * Search every page, reporting as it goes.
 *
 * `textOf` is expected to be cached by the caller — a second search of the same document
 * should not re-extract anything. The signal is honoured between pages, so typing another
 * character abandons the previous search rather than racing it.
 */
export async function searchDocument(
	query: string,
	pageCount: number,
	textOf: (page: number) => Promise<string>,
	options: { signal?: AbortSignal; onProgress?: (progress: SearchProgress) => void } = {},
): Promise<SearchHit[]> {
	const needle = normalise(query).trim();
	if (needle === "") return [];

	const hits: SearchHit[] = [];

	for (let page = 1; page <= pageCount; page++) {
		if (options.signal?.aborted) return hits;

		let text: string;
		try {
			text = await textOf(page);
		} catch {
			// One unreadable page costs its own results, never the search.
			continue;
		}

		hits.push(...findInPage(text, page, needle));
		options.onProgress?.({ done: page, total: pageCount, hits: [...hits] });
	}

	return hits;
}
