/**
 * Is this PDF a slide deck or a prose document?
 *
 * It matters because the two want completely different notes. A deck's page *is* its unit of
 * meaning, so one heading per page with the slide embedded is right. A handout's page break
 * is an accident of pagination — giving each page a heading and quoting a whole page of prose
 * as a blockquote produces something nobody would read.
 *
 * The signals, measured across a real corpus of 17 course PDFs sorted by hand into
 * "Lecture Slides" and "Course Materials":
 *
 *   slides     landscape, ~240–400 characters per page, bulleted
 *   documents  portrait, ~1800–2600 characters per page, continuous prose
 *
 * Orientation alone is nearly sufficient and is checked first; text density decides when the
 * page size is unknown or the aspect ratio is ambiguous.
 *
 * Pure — see PLAN.md §3.1.
 */

export type PdfShape = "slides" | "document";

export interface ShapeSignals {
	/** Page dimensions in PDF units. Zeros mean the viewport could not be read. */
	sizes: readonly { width: number; height: number }[];
	/** Characters of extracted text per page. */
	charactersPerPage: number;
	pageCount: number;
}

/** Above this many characters a page is carrying prose, not bullet points. */
export const DOCUMENT_DENSITY = 900;

/** A page this much wider than tall is a slide. 4:3 is 1.33, 16:9 is 1.78. */
const LANDSCAPE_RATIO = 1.2;

export interface ShapeVerdict {
	shape: PdfShape;
	/** Why, in a form worth showing the user when the guess looks wrong. */
	reason: string;
}

export function classifyShape(signals: ShapeSignals): ShapeVerdict {
	const { sizes, charactersPerPage } = signals;

	const measured = sizes.filter((s) => s.width > 0 && s.height > 0);
	const landscape = measured.filter((s) => s.width / s.height >= LANDSCAPE_RATIO).length;

	if (measured.length > 0) {
		const share = landscape / measured.length;

		// Mostly landscape is a deck, whatever the density: a dense slide is still a slide.
		if (share >= 0.6) return { shape: "slides", reason: "pages are landscape" };

		// Mostly portrait and dense is a handout.
		if (share <= 0.4 && charactersPerPage >= DOCUMENT_DENSITY) {
			return { shape: "document", reason: `portrait pages averaging ${Math.round(charactersPerPage)} characters` };
		}

		// Portrait but sparse — a printed deck, a poster, a cover sheet. Treat it as slides,
		// because per-page notes on a sparse page lose nothing, while running the document
		// pipeline over near-empty pages produces a note with headings and no content.
		if (share <= 0.4) return { shape: "slides", reason: "portrait but sparse, so treated as pages" };
	}

	// No usable page sizes: density is all there is.
	return charactersPerPage >= DOCUMENT_DENSITY
		? { shape: "document", reason: `dense text (${Math.round(charactersPerPage)} characters per page)` }
		: { shape: "slides", reason: "sparse text" };
}

/** Characters per page across an extracted document. */
export function densityOf(pages: readonly { length: number }[], textLength: (page: unknown) => number): number {
	if (pages.length === 0) return 0;
	let total = 0;
	for (const page of pages) total += textLength(page);
	return total / pages.length;
}
