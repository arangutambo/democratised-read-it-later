import { describe, expect, it } from "vitest";

import { ZoteroIndex } from "../../../src/sources/zotero/lookup";
import type { ZoteroReadResult } from "../../../src/sources/zotero/db";

/** A library with two papers: one Better BibTeX knows, one it does not. */
function library(overrides: Partial<ZoteroReadResult> = {}): ZoteroReadResult {
	return {
		items: [
			{ itemID: 1, key: "AAA", typeName: "journalArticle" },
			{ itemID: 2, key: "BBB", typeName: "journalArticle" },
		],
		annotations: [],
		fields: [
			{ itemID: 1, fieldName: "title", value: "What is a hidden Markov model?" },
			{ itemID: 1, fieldName: "date", value: "2004-10-01" },
			{ itemID: 1, fieldName: "DOI", value: "10.1038/nbt1004-1315" },
			{ itemID: 2, fieldName: "title", value: "Discovering sequence motifs" },
			{ itemID: 2, fieldName: "date", value: "2009" },
		] as ZoteroReadResult["fields"],
		creators: [
			{ itemID: 1, creatorType: "author", firstName: "Sean", lastName: "Eddy" },
			{ itemID: 2, creatorType: "author", firstName: "Timothy", lastName: "Bailey" },
		] as unknown as ZoteroReadResult["creators"],
		citekeys: new Map([[1, "eddyWhatHiddenMarkov2004"]]),
		attachments: [
			{ itemID: 10, parentItemID: 1, path: "storage:hmm.pdf", linkMode: 0, key: "KEYA" },
			{ itemID: 11, parentItemID: 2, path: "/Users/someone/papers/motifs.pdf", linkMode: 2, key: "KEYB" },
			// A trashed parent: present as an attachment, absent from `items`.
			{ itemID: 12, parentItemID: 99, path: "storage:gone.pdf", linkMode: 0, key: "KEYC" },
		],
		warnings: [],
		...overrides,
	};
}

const index = () => ZoteroIndex.fromRead(library(), "/Users/someone/Zotero");

describe("ZoteroIndex.find", () => {
	it("matches a stored attachment by its resolved path", () => {
		const match = index().find("/Users/someone/Zotero/storage/KEYA/hmm.pdf");

		expect(match).toMatchObject({
			citekey: "eddyWhatHiddenMarkov2004",
			how: "path",
			citekeyFrom: "bibtex",
		});
		expect(match?.csl.title).toBe("What is a hidden Markov model?");
	});

	it("matches a linked attachment at its absolute path", () => {
		expect(index().find("/Users/someone/papers/motifs.pdf")?.how).toBe("path");
	});

	it("matches by filename when the file has been copied into the vault", () => {
		// The copy in the vault is exactly what Reader opens, and it is not where Zotero left it.
		const match = index().find("/Users/someone/Documents/Vault/Sources/_decks/hmm.pdf");
		expect(match).toMatchObject({ how: "filename", citekey: "eddyWhatHiddenMarkov2004" });
	});

	it("is case-insensitive, because macOS paths are", () => {
		expect(index().find("/users/someone/Zotero/storage/KEYA/HMM.PDF")).toBeDefined();
	});

	it("generates a citekey when Better BibTeX has none, and says so", () => {
		/*
		 * Measured against a real library: BBT only records a key once it is pinned or
		 * exported. Refusing the rest would leave most papers with no frontmatter at all — but
		 * a generated key will not match library.bib, so the caller has to be able to say that.
		 */
		const match = index().find("/Users/someone/papers/motifs.pdf");

		expect(match?.citekeyFrom).toBe("reader");
		expect(match?.citekey).toContain("bailey");
		expect(match?.citekey).toContain("2009");
	});

	it("carries the CSL fields a citation needs", () => {
		const csl = index().find("/Users/someone/Zotero/storage/KEYA/hmm.pdf")?.csl;

		expect(csl).toMatchObject({ type: "article-journal", DOI: "10.1038/nbt1004-1315" });
		expect(csl?.issued).toEqual({ "date-parts": [[2004]] });
		expect(csl?.author?.[0]).toMatchObject({ family: "Eddy" });
	});

	it("ignores an attachment whose item is in the trash", () => {
		// 48 of 64 attachments in the real library are trashed; offering their metadata would
		// attach a citekey to a paper the user has deliberately thrown away.
		expect(index().find("/Users/someone/Zotero/storage/KEYC/gone.pdf")).toBeUndefined();
	});

	it("returns nothing for a file Zotero has never seen", () => {
		expect(index().find("/Users/someone/Downloads/lecture.pdf")).toBeUndefined();
	});

	it("does not hand two papers the same generated key", () => {
		const withNeither = ZoteroIndex.fromRead(library({ citekeys: new Map() }), "/Users/someone/Zotero");

		const first = withNeither.find("/Users/someone/Zotero/storage/KEYA/hmm.pdf");
		const second = withNeither.find("/Users/someone/papers/motifs.pdf");

		expect(first?.citekey).not.toBe(second?.citekey);
	});
});
