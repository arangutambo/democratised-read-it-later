/**
 * @vitest-environment happy-dom
 */

/**
 * What a fetched transcript is written as.
 *
 * The point of this format is that it is not a new one: a video saved from YouTube today and a
 * video that came out of a Readwise export years ago have to be the same kind of file, or every
 * surface downstream grows a second code path. So the test that matters is the round trip —
 * write it, read it back with the parser that already exists, and get the cues out unchanged.
 */

import { describe, expect, it } from "vitest";

import { transcriptDocument, type FetchedTranscript } from "../../src/video/save";
import { isTranscript, parseCues, toParagraphs } from "../../src/video/transcript";

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

const SAMPLE: FetchedTranscript = {
	videoId: "dQw4w9WgXcQ",
	title: "Never Gonna Give You Up",
	author: "Rick Astley",
	durationSeconds: 213,
	cues: [
		{ start: 0, text: "We're no strangers to love" },
		{ start: 4.5, text: "You know the rules and so do I" },
		{ start: 43, text: "Never gonna give you up" },
	],
};

describe("a fetched transcript as a document", () => {
	it("round-trips through the parser the Readwise documents use", () => {
		const cues = parseCues(transcriptDocument(SAMPLE, "https://youtu.be/dQw4w9WgXcQ"), parse);
		expect(cues).toEqual(SAMPLE.cues);
	});

	it("is recognised as a transcript, which is how the reader picks its surface", () => {
		expect(isTranscript(transcriptDocument(SAMPLE, "https://youtu.be/dQw4w9WgXcQ"))).toBe(true);
	});

	it("groups into paragraphs on the same seam as everything else", () => {
		const cues = parseCues(transcriptDocument(SAMPLE, "https://youtu.be/dQw4w9WgXcQ"), parse);
		const paragraphs = toParagraphs(cues);

		// 0s and 4.5s share a paragraph; 43s is past the 30-second seam.
		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0].text).toBe("We're no strangers to love You know the rules and so do I");
	});

	/**
	 * A transcript is third-party text. It reaches disk as markup, so anything that looks like
	 * markup in it has to stop being markup before it is written, not when it is rendered.
	 */
	it("escapes text that would otherwise become markup", () => {
		const nasty: FetchedTranscript = {
			...SAMPLE,
			title: 'Tags & "quotes" <script>',
			cues: [{ start: 0, text: "<script>alert(1)</script> & co" }],
		};

		const html = transcriptDocument(nasty, "https://youtu.be/x");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");

		// And it survives the round trip as the text it was.
		expect(parseCues(html, parse)[0].text).toBe("<script>alert(1)</script> & co");
	});

	it("keeps sub-second timings, which the rendered panel would have lost", () => {
		const precise: FetchedTranscript = { ...SAMPLE, cues: [{ start: 12.345, text: "exact" }] };
		expect(parseCues(transcriptDocument(precise, "https://youtu.be/x"), parse)[0].start).toBe(12.345);
	});

	it("records the video id and the canonical URL in the document itself", () => {
		const html = transcriptDocument(SAMPLE, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(html).toContain('data-rw-video-id="dQw4w9WgXcQ"');
		expect(html).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	});
});
