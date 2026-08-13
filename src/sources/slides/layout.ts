/**
 * Reconstructing reading order from a PDF's text items.
 *
 * pdf.js hands back positioned glyph runs, not lines: a slide's bullet may arrive as five
 * separate items, and their order in the array follows the drawing order in the content
 * stream, which is frequently not the order a human reads them. Lines therefore have to be
 * rebuilt from coordinates.
 *
 * PDF's origin is bottom-left, so a *larger* y is further up the page.
 *
 * Pure — no pdf.js, no `obsidian`, no DOM. `extract.ts` converts pdf.js items into the shape
 * below so that all of this logic is testable without a PDF. See PLAN.md §3.1.
 */

export interface TextItem {
	str: string;
	/** Horizontal position, PDF units, increasing rightwards. */
	x: number;
	/** Vertical position, PDF units, increasing **upwards**. */
	y: number;
	/** Glyph height, used as a proxy for font size. */
	height: number;
	width: number;
}

export interface Line {
	text: string;
	y: number;
	/** Largest glyph height on the line — what makes a title detectable. */
	size: number;
}

/**
 * Items within this many PDF units of each other vertically belong to the same line.
 *
 * Not zero: subscripts, differing fonts on one line, and the rounding in a slide generator's
 * output all shift the baseline slightly. Too large and two lines of dense body text merge.
 */
const LINE_TOLERANCE = 3;

/**
 * A gap wider than this fraction of the preceding item's average character width is a space.
 *
 * Normalised against character width rather than line height, because height is the wrong
 * yardstick: a bounding box spans ascender to descender, so a genuine inter-word gap lands
 * at roughly 0.25 of it — indistinguishable from the kerning inside a word that a PDF
 * generator happened to split across two items. Measured on real lecture decks, the height
 * rule silently produced "BINF7001Advanced" and "Don'tpanic".
 *
 * It also makes the rule source-independent. pdf.js usually emits whole runs with their own
 * spaces; poppler emits one item per word with none. Character width scales with both.
 */
const SPACE_RATIO = 0.3;

function averageCharWidth(item: TextItem): number {
	if (item.width > 0 && item.str.length > 0) return item.width / item.str.length;
	// No width reported — half the glyph height is a serviceable stand-in for an en space.
	return item.height * 0.5;
}

function joinItems(items: readonly TextItem[]): string {
	const sorted = [...items].sort((a, b) => a.x - b.x);
	let text = "";

	for (let i = 0; i < sorted.length; i++) {
		const item = sorted[i];
		if (i > 0) {
			const previous = sorted[i - 1];
			const gap = item.x - (previous.x + previous.width);
			const needsSpace = gap > averageCharWidth(previous) * SPACE_RATIO;
			const alreadySpaced = text.endsWith(" ") || item.str.startsWith(" ");
			if (needsSpace && !alreadySpaced) text += " ";
		}
		text += item.str;
	}

	return text.replace(/\s+/g, " ").trim();
}

/** Group positioned items into lines, top of the page first. */
export function toLines(items: readonly TextItem[]): Line[] {
	const meaningful = items.filter((item) => item.str.trim() !== "");
	if (meaningful.length === 0) return [];

	// Descending y walks the page downwards, which is the order a reader takes it in.
	const byHeight = [...meaningful].sort((a, b) => b.y - a.y);

	const groups: TextItem[][] = [];
	let current: TextItem[] = [byHeight[0]];

	for (let i = 1; i < byHeight.length; i++) {
		const item = byHeight[i];
		if (Math.abs(item.y - current[0].y) <= LINE_TOLERANCE) current.push(item);
		else {
			groups.push(current);
			current = [item];
		}
	}
	groups.push(current);

	return groups
		.map((group) => ({
			text: joinItems(group),
			y: group[0].y,
			size: Math.max(...group.map((item) => item.height)),
		}))
		.filter((line) => line.text !== "");
}

/** Lines joined into the slide's plain text, one line per newline. */
export function linesToText(lines: readonly Line[]): string {
	return lines.map((line) => line.text).join("\n").trim();
}
