/**
 * Turning a deck into a study note.
 *
 * DESIGN.md §7: "emit a note where each slide is a heading with its image, its text, and **an
 * empty space for your own writing** — the point is a scaffold, not a transcript."
 *
 * Three decisions follow from that, and from what the real corpus looks like:
 *
 * 1. **The slide is embedded, not rendered.** `![[deck.pdf#page=3]]` is native Obsidian and
 *    shows the actual slide. Rendering 322 pages to PNG would add hundreds of megabytes to a
 *    vault already carrying 2.4 GB of images, to show something the PDF already contains.
 * 2. **Each slide's extracted text is its own managed region.** The plugin owns the text; the
 *    space beneath it is the user's. Re-importing a deck updates the text without touching a
 *    word of what they wrote — and if they edited inside a region, that one slide reports a
 *    conflict rather than the whole note being refused.
 * 3. **Heading level follows structure.** Section and summary slides become `##`, content
 *    slides `###`, so the outline pane shows the shape of the lecture instead of a flat run
 *    of forty headings.
 *
 * Pure — see PLAN.md §3.1.
 */

import { renderRegion } from "../../core/managed-region";
import type { Slide } from "./structure";

export const SLIDE_REGION_PREFIX = "slide-";

export function slideRegionName(index: number): string {
	return `${SLIDE_REGION_PREFIX}${index}`;
}

export interface DeckNoteOptions {
	/** Vault-relative path to the PDF, used for the page embeds. */
	deckPath: string;
	/** Skip slides that carry no text at all. */
	skipBlank?: boolean;
	/** Include the extracted text under each slide. Off makes a pure visual scaffold. */
	includeText?: boolean;
}

/** `![[deck.pdf#page=N]]` needs only the filename when it is unambiguous, but the full
 * vault-relative path always resolves, so that is what is emitted. */
function embed(deckPath: string, page: number): string {
	return `![[${deckPath}#page=${page}]]`;
}

function headingFor(slide: Slide): string {
	const level = slide.kind === "section" || slide.kind === "summary" ? "##" : "###";
	const label = slide.title ?? `Slide ${slide.index}`;
	return `${level} ${slide.index}. ${label}`;
}

/** The extracted text, quoted so it reads as the deck's words rather than the user's. */
function quoted(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

/**
 * Build the body of a deck note.
 *
 * Frontmatter is added by the caller; this is everything below it, so the function stays
 * pure and testable.
 */
export function buildDeckBody(slides: readonly Slide[], options: DeckNoteOptions): string {
	const { deckPath, skipBlank = true, includeText = true } = options;
	const parts: string[] = [];

	for (const slide of slides) {
		if (skipBlank && slide.kind === "blank") continue;

		parts.push(headingFor(slide));
		parts.push("");
		parts.push(embed(deckPath, slide.index));
		parts.push("");

		if (includeText && slide.text !== "") {
			parts.push(renderRegion(slideRegionName(slide.index), quoted(slide.text)));
			parts.push("");
		}

		// The empty line below the region is the point of the whole exercise: it is where
		// the reader writes, and nothing the plugin does later will touch it.
		parts.push("");
	}

	return parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

export interface DeckSummary {
	slideCount: number;
	sections: number;
	blanks: number;
	withText: number;
}

export function summarise(slides: readonly Slide[]): DeckSummary {
	return {
		slideCount: slides.length,
		sections: slides.filter((s) => s.kind === "section").length,
		blanks: slides.filter((s) => s.kind === "blank").length,
		withText: slides.filter((s) => s.text !== "").length,
	};
}
