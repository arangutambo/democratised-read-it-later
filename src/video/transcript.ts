/**
 * A video's transcript, as something you can read and point at.
 *
 * Readwise stores one as a single enormous `<p>` of per-phrase `<span data-rw-start="…">`
 * elements — 126 KB for an 18-minute video, 772 KB for the longest in this export. Rendered
 * literally that is an unbroken wall of text with no paragraph anywhere, which is unreadable
 * and also unclippable: there is nothing to aim at.
 *
 * So the phrases are regrouped into paragraphs. The timestamps survive the regrouping because
 * they are what a frame capture needs — the moment a highlight refers to — even though they
 * never appear in a note. The brief was explicit that a timestamp is not what you want written
 * down; the picture at that moment is.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** One phrase, as Readwise recorded it. */
export interface Cue {
	/** Seconds into the video. */
	start: number;
	text: string;
}

export interface TranscriptParagraph {
	index: number;
	/** Seconds into the video, from the first cue in it. */
	start: number;
	text: string;
	cues: Cue[];
}

/** Marks a document as a transcript rather than an article. */
export const TRANSCRIPT_MARKER = "data-rw-transcript-version";

export function isTranscript(html: string): boolean {
	return html.includes(TRANSCRIPT_MARKER);
}

/**
 * Roughly how long a paragraph runs before a new one starts, in seconds.
 *
 * A transcript has no paragraphs of its own — speech does not come with them — so the seam has
 * to be invented. Time is the honest basis: it groups what was said together, and it stays
 * stable regardless of how the recogniser happened to chop up its phrases.
 */
const PARAGRAPH_SECONDS = 30;

export type HtmlParser = (html: string) => Document;

/** Every phrase, in order. */
export function parseCues(html: string, parse: HtmlParser): Cue[] {
	const doc = parse(html);
	const cues: Cue[] = [];

	for (const span of Array.from(doc.querySelectorAll(`span[${TRANSCRIPT_MARKER}]`))) {
		const start = Number(span.getAttribute("data-rw-start"));
		const text = (span.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!Number.isFinite(start) || text === "") continue;

		cues.push({ start, text });
	}

	return cues;
}

/** The transcript as paragraphs you can actually read. */
export function toParagraphs(cues: readonly Cue[], seconds = PARAGRAPH_SECONDS): TranscriptParagraph[] {
	const out: TranscriptParagraph[] = [];
	let current: TranscriptParagraph | undefined;

	for (const cue of cues) {
		if (!current || cue.start - current.start >= seconds) {
			current = { index: out.length + 1, start: cue.start, text: "", cues: [] };
			out.push(current);
		}

		current.cues.push(cue);
		current.text = current.text === "" ? cue.text : `${current.text} ${cue.text}`;
	}

	return out;
}

/** Parse a Readwise transcript document straight to paragraphs. */
export function parseTranscript(html: string, parse: HtmlParser): TranscriptParagraph[] {
	return toParagraphs(parseCues(html, parse));
}

/**
 * The moment a piece of selected text was said.
 *
 * Used by a frame capture: you highlight a sentence, and the frame taken is the one from when
 * it was spoken. Matches on the cue whose text contains the start of the selection, falling
 * back to the paragraph, because a selection routinely spans several cues.
 */
export function startOf(paragraph: TranscriptParagraph, selected: string): number {
	const needle = selected.replace(/\s+/g, " ").trim().toLowerCase();
	if (needle === "") return paragraph.start;

	for (const cue of paragraph.cues) {
		const text = cue.text.toLowerCase();
		if (text.includes(needle.slice(0, Math.min(needle.length, 24)))) return cue.start;
	}

	// A selection that begins mid-cue: find the cue whose text the selection starts with.
	for (const cue of paragraph.cues) {
		if (needle.startsWith(cue.text.toLowerCase().slice(0, 12))) return cue.start;
	}

	return paragraph.start;
}

/** `12:04`, for the transcript gutter. Never written into a note. */
export function clockOf(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;

	const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
	return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
