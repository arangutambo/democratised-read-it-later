/**
 * What a document points at, and what a cascading delete would take.
 *
 * The interesting cases are all about not deleting things that are not ours: a source that
 * lives outside the vault, a `.reader` that was renamed since, one that was never indexed.
 */

import { describe, expect, it } from "vitest";

import { cascadeTargets, DocumentLinks } from "../../src/library/links";
import type { ReaderDocument } from "../../src/reader/document";

function doc(notePath: string, sourcePath: string): ReaderDocument {
	return {
		notePath,
		source: { path: sourcePath, kind: "pdf" },
		clips: {},
	} as unknown as ReaderDocument;
}

describe("DocumentLinks", () => {
	it("remembers what a document pointed at", () => {
		const links = new DocumentLinks();
		links.remember("Sources/A.reader", doc("Sources/A.md", "Sources/_decks/A.pdf"));

		expect(links.get("Sources/A.reader")).toEqual({
			notePath: "Sources/A.md",
			sourcePath: "Sources/_decks/A.pdf",
		});
	});

	it("hands back the link as it forgets it, which is what a deletion needs", () => {
		const links = new DocumentLinks();
		links.remember("Sources/A.reader", doc("Sources/A.md", "Sources/_decks/A.pdf"));

		expect(links.forget("Sources/A.reader")?.notePath).toBe("Sources/A.md");
		expect(links.get("Sources/A.reader")).toBeUndefined();
	});

	it("follows a document that was renamed", () => {
		const links = new DocumentLinks();
		links.remember("Sources/A.reader", doc("Sources/A.md", "Sources/_decks/A.pdf"));
		links.rename("Sources/A.reader", "Archive/A.reader");

		expect(links.get("Sources/A.reader")).toBeUndefined();
		expect(links.get("Archive/A.reader")?.notePath).toBe("Sources/A.md");
	});

	it("renaming something it never knew about does nothing", () => {
		const links = new DocumentLinks();
		links.rename("Sources/Ghost.reader", "Archive/Ghost.reader");
		expect(links.size).toBe(0);
	});
});

describe("cascadeTargets", () => {
	it("takes the note and the document", () => {
		expect(cascadeTargets({ notePath: "Sources/A.md", sourcePath: "Sources/_decks/A.pdf" })).toEqual([
			"Sources/A.md",
			"Sources/_decks/A.pdf",
		]);
	});

	/**
	 * The one that matters. A file outside the vault was never copied in — it is someone's
	 * only copy sitting in their own folders, and Reader deleting it would be indefensible.
	 */
	it("never touches a source that lives outside the vault", () => {
		expect(
			cascadeTargets({ notePath: "Sources/A.md", sourcePath: "/Users/you/Library/A.pdf" }),
		).toEqual(["Sources/A.md"]);
	});

	it("has nothing to do for a document it never indexed", () => {
		expect(cascadeTargets(undefined)).toEqual([]);
	});

	it("skips an empty note path rather than trying to trash the vault root", () => {
		expect(cascadeTargets({ notePath: "", sourcePath: "Sources/_decks/A.pdf" })).toEqual([
			"Sources/_decks/A.pdf",
		]);
	});
});
