import { describe, expect, it } from "vitest";

import { describeRemoval, writtenCharsIn, type RemovalPlan } from "../../src/library/remove";

const NOTE_HEAD = "---\nreaderSourceId: readwise:01h\ntitle: Something\n---\n\n";

function plan(o: Partial<RemovalPlan> = {}): RemovalPlan {
	return {
		readerPath: "Sources/w.reader",
		notePath: "Sources/w.md",
		documentPath: "Sources/_decks/w.pdf",
		writtenChars: 0,
		clips: 0,
		...o,
	};
}

describe("writtenCharsIn", () => {
	it("is zero for a note that is only frontmatter", () => {
		expect(writtenCharsIn(NOTE_HEAD)).toBe(0);
	});

	it("does not count clips this plugin wrote", () => {
		/*
		 * The number exists to decide how loud the confirmation is, and a note full of clips
		 * with nothing of yours in it is not the case that needs a warning.
		 */
		const note = `${NOTE_HEAD}- > A quote I clipped ^hl-01\n- ![[Sources/_assets/p1.png]] ^hl-02\n`;
		expect(writtenCharsIn(note)).toBe(0);
	});

	it("counts prose you typed", () => {
		expect(writtenCharsIn(`${NOTE_HEAD}This is mine.`)).toBe(13);
	});

	it("counts your prose even among clips", () => {
		const note = `${NOTE_HEAD}- > clipped ^hl-01\nMy own thought.\n`;
		expect(writtenCharsIn(note)).toBe(15);
	});

	it("ignores blank lines", () => {
		expect(writtenCharsIn(`${NOTE_HEAD}\n\n\n`)).toBe(0);
	});

	it("copes with a note that has no frontmatter", () => {
		expect(writtenCharsIn("Just prose.")).toBe(11);
	});
});

describe("describeRemoval", () => {
	it("says what survives when only the library entry goes", () => {
		const text = describeRemoval(plan(), false);

		expect(text).toContain("stay where they are");
		expect(text).not.toContain("trash");
	});

	it("names the three files when everything goes", () => {
		expect(describeRemoval(plan(), true)).toContain("document, your note and Reader's file");
	});

	it("warns when the note holds your writing", () => {
		// The whole point of the plugin is that this accumulates; losing it silently is the
		// worst outcome available here.
		expect(describeRemoval(plan({ writtenChars: 420 }), true)).toContain("420 characters");
	});

	it("says how much was clipped out of it", () => {
		expect(describeRemoval(plan({ clips: 1 }), true)).toContain("1 clip was taken");
		expect(describeRemoval(plan({ clips: 3 }), true)).toContain("3 clips were taken");
	});

	it("does not mention writing that is not there", () => {
		expect(describeRemoval(plan(), true)).not.toContain("characters");
	});
});
