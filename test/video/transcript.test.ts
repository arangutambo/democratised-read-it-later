/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import {
	clockOf,
	isTranscript,
	parseCues,
	parseTranscript,
	startOf,
	toParagraphs,
} from "../../src/video/transcript";
const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");
/** The exact shape Readwise writes: one <p>, per-phrase spans, a start on each. */
function transcript(...phrases: [number, string][]): string {
	const spans = phrases
		.map(([t, text]) => `<span data-rw-transcript-version="2" data-rw-start="${t}">${text} </span>`)
		.join("");
	return `<p>${spans}</p>`;
}
const SAMPLE = transcript(
	[0, "One of the best pieces of advice"],
	[1.76, "that I ever got as a medical student"],
	[40, "was to separate the person"],
	[42.5, "from the behaviour"],
);
describe("isTranscript", () => {
	it("recognises a Readwise transcript", () => {
		expect(isTranscript(SAMPLE)).toBe(true);
	});
	it("does not claim an ordinary article", () => {
		expect(isTranscript("<p>Just an article.</p>")).toBe(false);
	});
});
describe("parseCues", () => {
	it("reads every phrase with its timestamp", () => {
		const cues = parseCues(SAMPLE, parse);
		expect(cues).toHaveLength(4);
		expect(cues[0]).toEqual({ start: 0, text: "One of the best pieces of advice" });
		expect(cues[3].start).toBe(42.5);
	});
	it("skips a span with no usable timestamp", () => {
		const html = '<p><span data-rw-transcript-version="2" data-rw-start="x">bad</span></p>';
		expect(parseCues(html, parse)).toEqual([]);
	});
	it("skips an empty phrase rather than making a blank cue", () => {
		const html = '<p><span data-rw-transcript-version="2" data-rw-start="1">   </span></p>';
		expect(parseCues(html, parse)).toEqual([]);
	});
});
describe("toParagraphs", () => {
	it("groups speech into paragraphs, since a transcript has none", () => {
		/*
		 * Rendered literally a transcript is one unbroken wall — 126 KB for an 18-minute video.
		 * That is unreadable, and worse, unclippable: there is nothing to aim at.
		 */
		const paragraphs = toParagraphs(parseCues(SAMPLE, parse));
		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0].text).toBe(
			"One of the best pieces of advice that I ever got as a medical student",
		);
		expect(paragraphs[1].text).toBe("was to separate the person from the behaviour");
	});
	it("takes its start from the first cue in it", () => {
		expect(toParagraphs(parseCues(SAMPLE, parse))[1].start).toBe(40);
	});
	it("numbers paragraphs from one", () => {
		expect(parseTranscript(SAMPLE, parse).map((p) => p.index)).toEqual([1, 2]);
	});
	it("keeps its cues, which is what a frame capture needs", () => {
		expect(toParagraphs(parseCues(SAMPLE, parse))[0].cues).toHaveLength(2);
	});
	it("loses no words", () => {
		const cues = parseCues(SAMPLE, parse);
		const words = toParagraphs(cues).flatMap((p) => p.cues).length;
		expect(words).toBe(cues.length);
	});
	it("is empty for an empty transcript", () => {
		expect(toParagraphs([])).toEqual([]);
	});
});
describe("startOf", () => {
	const paragraph = toParagraphs(parseCues(SAMPLE, parse))[0];
	it("finds the moment a selected sentence was said", () => {
		// Highlight a sentence, and the frame taken is the one from when it was spoken.
		expect(startOf(paragraph, "that I ever got as a medical student")).toBe(1.76);
	});
	it("falls back to the paragraph when the selection spans cues", () => {
		expect(startOf(paragraph, "advice that I ever got")).toBe(0);
	});
	it("falls back to the paragraph for an empty selection", () => {
		expect(startOf(paragraph, "   ")).toBe(0);
	});
});
describe("clockOf", () => {
	it("reads as a clock", () => {
		expect(clockOf(0)).toBe("0:00");
		expect(clockOf(75)).toBe("1:15");
		expect(clockOf(3725)).toBe("1:02:05");
	});
	it("never goes negative", () => {
		expect(clockOf(-5)).toBe("0:00");
	});
});
