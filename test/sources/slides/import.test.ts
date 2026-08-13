import { describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { TFile } from "../../stubs/obsidian";

import { pickTitle, uniqueNotePath } from "../../../src/sources/slides/import";

describe("pickTitle", () => {
	it("prefers a substantial title-slide title", () => {
		expect(pickTitle("BINF7001 Advanced Genome Informatics Module 1", "whatever", "BINF7001_WEEK1")).toBe(
			"BINF7001 Advanced Genome Informatics Module 1",
		);
	});

	it("rejects a one-word title slide and uses the filename", () => {
		// A real deck's title slide reads only "notes", which produced notes.md with the
		// citekey `personalnotes`.
		expect(pickTitle("notes", undefined, "Week 3 Learning guide")).toBe("Week 3 Learning guide");
	});

	it("never prefers PDF metadata over the filename", () => {
		// Several BINF7001 exports all carry the metadata title "BINF7001_2026_WEEK1_allSlides"
		// whatever week they are, so trusting it collapsed distinct decks onto one note.
		const meta = "BINF7001_2026_WEEK1_allSlides";
		expect(pickTitle(undefined, meta, "BINF7001_2026_WEEK2.allSlides")).toBe("BINF7001_2026_WEEK2.allSlides");
		expect(pickTitle(undefined, meta, "BINF7001_2026_WEEK1_Part2_and_Part3_slides")).toBe(
			"BINF7001_2026_WEEK1_Part2_and_Part3_slides",
		);
	});

	it("gives distinct titles to the three decks that collided", () => {
		const meta = "BINF7001_2026_WEEK1_allSlides";
		const titles = [
			pickTitle("BINF7001 Advanced Genome Informatics Module 1", meta, "BINF7001_2026_WEEK1_IntroductoryLecture"),
			pickTitle(undefined, meta, "BINF7001_2026_WEEK1_Part2_and_Part3_slides"),
			pickTitle(undefined, meta, "BINF7001_2026_WEEK2.allSlides"),
		];
		expect(new Set(titles).size).toBe(3);
	});

	it("falls back to metadata only when there is no filename", () => {
		expect(pickTitle(undefined, "A Real Metadata Title", "")).toBe("A Real Metadata Title");
	});

	it("never returns an empty name", () => {
		expect(pickTitle(undefined, undefined, "")).toBe("Untitled deck");
	});
});

/**
 * `cached: false` models the real metadata cache, which does not yet know about a note
 * created milliseconds earlier — the lag that let one book overwrite another's note.
 */
function fakeApp(notes: Record<string, string | undefined>, cached = true): App {
	return {
		vault: {
			getAbstractFileByPath: (p: string) =>
				p in notes ? Object.assign(new TFile(), { path: p }) : null,
			read: async (file: { path: string }) =>
				`---\nreaderSourceId: "${notes[file.path] ?? ""}"\n---\n`,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => ({
				frontmatter: cached ? { readerSourceId: notes[file.path] } : {},
			}),
		},
	} as unknown as App;
}

describe("uniqueNotePath", () => {
	it("uses the plain title when nothing is there", async () => {
		expect(await uniqueNotePath(fakeApp({}), "Sources", "Week 2", "deck-b", "Sources/_decks/deck-b.pdf")).toBe(
			"Sources/Week 2.md",
		);
	});

	it("keeps the same note when the same deck is re-imported", async () => {
		const app = fakeApp({ "Sources/Week 2.md": "Sources/_decks/deck-b.pdf" });
		expect(await uniqueNotePath(app, "Sources", "Week 2", "deck-b", "Sources/_decks/deck-b.pdf")).toBe(
			"Sources/Week 2.md",
		);
	});

	it("gives a different deck its own note instead of overwriting", async () => {
		// Three of twenty-two real decks silently rewrote another deck's slide text.
		const app = fakeApp({ "Sources/Week 2.md": "Sources/_decks/deck-a.pdf" });
		expect(await uniqueNotePath(app, "Sources", "Week 2", "deck-b", "Sources/_decks/deck-b.pdf")).toBe(
			"Sources/Week 2 (deck-b).md",
		);
	});

	it("still separates them when the metadata cache has not caught up", async () => {
		// The cache is asynchronous, so during a bulk import it reports nothing for a note
		// written moments ago. Falling back to reading the file is what makes this correct.
		const app = fakeApp({ "Sources/Week 2.md": "Sources/_decks/deck-a.pdf" }, false);
		expect(await uniqueNotePath(app, "Sources", "Week 2", "deck-b", "Sources/_decks/deck-b.pdf")).toBe(
			"Sources/Week 2 (deck-b).md",
		);
	});

	it("disambiguates with the deck's own filename, which is unique in a folder", async () => {
		const app = fakeApp({ "Sources/Untitled deck.md": "Sources/_decks/one.pdf" });
		const path = await uniqueNotePath(app, "Sources", "Untitled deck", "two", "Sources/_decks/two.pdf");
		expect(path).toContain("two");
	});
});
