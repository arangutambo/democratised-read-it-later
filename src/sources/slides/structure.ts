/**
 * Slide structure detection.
 *
 * DESIGN.md §7 step 2: "detect structure — title slides, section breaks, content, summary".
 * The point of knowing a slide's kind is that the note should not treat them alike. A title
 * slide needs no space to write under it; a content slide is where the writing goes.
 *
 * These are heuristics over a real 322-page corpus of lecture decks, not a parser. They are
 * deliberately conservative: when unsure the answer is `content`, because wrongly calling a
 * content slide a section break would drop the space to write under the slide that needed it.
 *
 * Pure — see PLAN.md §3.1.
 */

import { linesToText, type Line } from "./layout";

export type SlideKind = "title" | "section" | "content" | "summary" | "blank";

export interface Slide {
	/** 1-based, matching the page number a reader and `#page=` embeds both use. */
	index: number;
	kind: SlideKind;
	/** Detected heading, if the slide appears to have one. */
	title?: string;
	text: string;
	lines: Line[];
}

/** Slides whose whole job is to announce a part of the deck. */
const SECTION_WORDS =
	/^(outline|overview|agenda|contents?|topics?|part\s+\w+|section\s+\w+|introduction|background|methods?|results?|discussion|today|this\s+week|learning\s+objectives?|objectives?|aims?)\b/i;

const SUMMARY_WORDS =
	/^(summary|conclusions?|recap|key\s+(points?|takeaways?)|takeaways?|wrap[\s-]?up|questions?|further\s+reading|references?|acknowledge?ments?|thank\s*you)\b/i;

/** Below this many characters a slide is essentially a caption, not content. */
const SPARSE_CHARS = 120;

/**
 * A first slide with no more than this many lines is a title slide.
 *
 * Line count, not character count: real lecture title slides carry a course code, a title,
 * a subtitle, a semester, a lecturer and an email, which runs to 167 characters on
 * BINF7001 Week 1 while still being unmistakably a title slide at seven lines.
 */
const TITLE_SLIDE_MAX_LINES = 8;

/** A bullet marker means content, whatever the slide's position in the deck. */
const BULLET = /^\s*([-•▪◦*·‣]|\d+[.)]|[a-z][.)])\s+/i;

/** A line this much larger than the slide's median is acting as a heading. */
const TITLE_SIZE_RATIO = 1.15;

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * The slide's heading, if it has one.
 *
 * A title is the topmost line when it is either visibly larger than the rest of the slide or
 * the only line on it. Requiring size alone would miss decks that set every slide in one
 * size; requiring position alone would promote the first bullet of a headless slide.
 */
export function detectTitle(lines: readonly Line[]): string | undefined {
	if (lines.length === 0) return undefined;

	const first = lines[0];
	const candidate = first.text.trim();
	if (candidate === "" || candidate.length > 120) return undefined;
	// A bare number is a slide number, not a heading — several decks place theirs at the top.
	if (!/[A-Za-z]/.test(candidate)) return undefined;

	if (lines.length === 1) return candidate;

	const rest = lines.slice(1).map((line) => line.size);
	if (first.size >= median(rest) * TITLE_SIZE_RATIO) return candidate;

	// A short opening line with no terminal punctuation still reads as a heading.
	if (candidate.length <= 60 && !/[.:;,]$/.test(candidate)) return candidate;

	return undefined;
}

export function classify(lines: readonly Line[], index: number, totalSlides: number): SlideKind {
	const text = linesToText(lines);
	if (text === "") return "blank";

	const title = detectTitle(lines);
	const sparse = text.length < SPARSE_CHARS;

	if (title && SUMMARY_WORDS.test(title)) return "summary";
	// A summary heading late in the deck still counts even when the slide is dense.
	if (title && sparse && SECTION_WORDS.test(title)) return "section";

	// The opening slide is a title slide when it is short and makes no argument.
	const bulleted = lines.some((line) => BULLET.test(line.text));
	if (index === 1 && lines.length <= TITLE_SLIDE_MAX_LINES && !bulleted) return "title";

	// A sparse slide that is nothing but its heading is announcing a section.
	if (sparse && title && title.length === text.trim().length) {
		return index === totalSlides ? "summary" : "section";
	}

	return "content";
}

export function buildSlides(pages: readonly Line[][]): Slide[] {
	return pages.map((lines, i) => {
		const index = i + 1;
		return {
			index,
			kind: classify(lines, index, pages.length),
			title: detectTitle(lines),
			text: linesToText(lines),
			lines: [...lines],
		};
	});
}

/**
 * The deck's title, taken from its title slide.
 *
 * Consecutive leading lines sharing the largest font size are joined, because a deck title
 * is routinely typeset across two visual lines — "BINF7001 Advanced" above "Genome
 * Informatics" is one title, and taking only the first line truncates it.
 */
export function deckTitleOf(slide: Slide | undefined): string | undefined {
	if (!slide || slide.lines.length === 0) return undefined;

	const largest = Math.max(...slide.lines.map((line) => line.size));
	const parts: string[] = [];

	for (const line of slide.lines) {
		if (Math.abs(line.size - largest) > 0.5) break;
		parts.push(line.text.trim());
	}

	const title = parts.join(" ").replace(/\s+/g, " ").trim();
	return title === "" ? slide.title : title;
}

export interface DeckOutline {
	slides: Slide[];
	/** The deck's own title, taken from its title slide when it has one. */
	title?: string;
	counts: Record<SlideKind, number>;
}

export function outlineOf(slides: readonly Slide[]): DeckOutline {
	const counts: Record<SlideKind, number> = { title: 0, section: 0, content: 0, summary: 0, blank: 0 };
	for (const slide of slides) counts[slide.kind]++;

	const titleSlide = slides.find((s) => s.kind === "title");

	return { slides: [...slides], title: deckTitleOf(titleSlide), counts };
}
