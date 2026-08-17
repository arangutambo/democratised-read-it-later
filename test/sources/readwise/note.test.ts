import { describe, expect, it } from "vitest";

import {
	buildNote,
	documentPathFor,
	extensionOf,
	noteNameFor,
	readableExtension,
	sanitiseTitle,
} from "../../../src/sources/readwise/note";
import type { ReadwiseDocument } from "../../../src/sources/readwise/export";

function doc(overrides: Partial<ReadwiseDocument> = {}): ReadwiseDocument {
	return {
		id: "01hbz079n75sj4kqbmrssg12nj",
		title: "Wild Mushrooming",
		url: "https://example.com/mushrooms",
		tags: [],
		saved: "2023-09-01",
		progress: 0,
		location: "new",
		seen: true,
		...overrides,
	};
}

describe("sanitiseTitle", () => {
	it("removes characters a vault path cannot hold", () => {
		expect(sanitiseTitle('Stats: a "primer"/guide')).toBe("Stats- a -primer--guide");
	});

	it("truncates a title that runs to a whole sentence", () => {
		// Readwise titles routinely do; a filesystem stops caring long before 120 characters.
		expect(sanitiseTitle("x".repeat(300)).length).toBeLessThanOrEqual(120);
	});

	it("never produces an empty name", () => {
		expect(sanitiseTitle("   ")).toBe("Untitled");
		expect(sanitiseTitle("///")).toBe("Untitled");
	});
});

describe("noteNameFor", () => {
	it("carries the Readwise id, which is the only stable key", () => {
		// Titles collide once sanitised, and a second import must find the note it already
		// wrote rather than making another.
		expect(noteNameFor(doc())).toBe("Wild Mushrooming (01hbz079n75sj4kqbmrssg12nj).md");
	});
});

describe("buildNote", () => {
	it("stamps ownership with the Readwise id", () => {
		/*
		 * `readerSourceId` is what `note/ownership.ts` reads, so an imported stub and a capture
		 * note can never become the same file — the guard that v1 shipped broken twice.
		 */
		expect(buildNote(doc())).toContain("readerSourceId: readwise:01hbz079n75sj4kqbmrssg12nj");
	});

	it("records what the thing was and where it came from", () => {
		const note = buildNote(doc());

		expect(note).toContain("title: Wild Mushrooming");
		expect(note).toContain("url: https://example.com/mushrooms");
		expect(note).toContain("saved: 2023-09-01");
	});

	it("maps Readwise's location onto a reading state", () => {
		expect(buildNote(doc({ location: "archive" }))).toContain("readerState: archived");
		expect(buildNote(doc({ location: "shortlist" }))).toContain("readerState: reading");
	});

	it("writes progress as a percentage, which reads better in a properties panel", () => {
		expect(buildNote(doc({ progress: 0.37 }))).toContain("readerProgress: 37");
	});

	it("omits progress that is zero rather than writing a zero", () => {
		expect(buildNote(doc({ progress: 0 }))).not.toContain("readerProgress");
	});

	it("carries tags as a list", () => {
		expect(buildNote(doc({ tags: ["youtube", "favorite"] }))).toContain("tags:\n  - youtube\n  - favorite");
	});

	it("quotes a title that would otherwise break the YAML", () => {
		expect(buildNote(doc({ title: "Stats: a primer" }))).toContain('title: "Stats: a primer"');
	});

	it("links to the reader when the document itself was exported", () => {
		const note = buildNote(doc(), { readerPath: "Sources/Wild Mushrooming (01h).reader" });
		expect(note).toContain("[[Sources/Wild Mushrooming (01h).reader|Open in Reader]]");
	});

	it("links to the web when there is no local document", () => {
		expect(buildNote(doc())).toContain("[Wild Mushrooming](https://example.com/mushrooms)");
	});

	it("generates no content of its own", () => {
		/*
		 * The note is metadata and a link. v1 was rejected for producing transcripts, and a
		 * scaffold of headings would be the same mistake wearing a different hat.
		 */
		const body = buildNote(doc()).split("---")[2] ?? "";
		expect(body.trim().split("\n")).toHaveLength(1);
	});

	it("is valid frontmatter", () => {
		const note = buildNote(doc({ tags: ["a"] }));
		const lines = note.split("\n");

		expect(lines[0]).toBe("---");
		expect(lines.indexOf("---", 1)).toBeGreaterThan(1);
	});
});

describe("documentPathFor", () => {
	it("keeps the id so a re-import matches the same file", () => {
		expect(documentPathFor(doc(), "Sources/_documents", "pdf")).toBe(
			"Sources/_documents/Wild Mushrooming (01hbz079n75sj4kqbmrssg12nj).pdf",
		);
	});
});

describe("extensionOf", () => {
	it("reads the extension", () => {
		expect(extensionOf("Wild Mushrooming (01h).PDF")).toBe("pdf");
	});

	it("is empty when there is none", () => {
		expect(extensionOf("no-extension")).toBe("");
	});
});

describe("readableExtension", () => {
	it("recognises what Reader can open", () => {
		expect(readableExtension("pdf")).toBe("pdf");
		expect(readableExtension("epub")).toBe("epub");
	});

	it("claims HTML, which is the bulk of an export", () => {
		// 5,479 of 5,524 exported files. Without these an import is 44 documents and 2,000
		// links, which is not worth running.
		expect(readableExtension("html")).toBe("html");
		expect(readableExtension("htm")).toBe("html");
	});

	it("still refuses what Reader cannot render", () => {
		expect(readableExtension("docx")).toBeUndefined();
		expect(readableExtension("")).toBeUndefined();
	});
});
