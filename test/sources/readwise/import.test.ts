import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseExport, type ReadwiseDocument } from "../../../src/sources/readwise/export";
import { describePlan, planImport } from "../../../src/sources/readwise/import";

const REAL = path.resolve(process.cwd(), "test/private/readwise/export.csv");

function doc(overrides: Partial<ReadwiseDocument> = {}): ReadwiseDocument {
	return {
		id: "01h",
		title: "Wild Mushrooming",
		url: "https://example.com",
		tags: [],
		progress: 0,
		location: "new",
		seen: true,
		...overrides,
	};
}

const FOLDERS = { sourcesFolder: "Sources", documentsFolder: "Sources/_documents" };

describe("planImport", () => {
	it("plans a note for each document", () => {
		const plan = planImport([doc()], FOLDERS);

		expect(plan.writes).toHaveLength(1);
		expect(plan.writes[0].notePath).toBe("Sources/Wild Mushrooming (01h).md");
	});

	it("pairs a PDF in the zip with a .reader", () => {
		const plan = planImport([doc()], {
			...FOLDERS,
			zipEntries: ["Wild Mushrooming (01h).pdf"],
		});

		expect(plan.writes[0]).toMatchObject({
			zipEntry: "Wild Mushrooming (01h).pdf",
			documentPath: "Sources/_documents/Wild Mushrooming (01h).pdf",
			readerPath: "Sources/_documents/Wild Mushrooming (01h).reader",
		});
		expect(plan.linkOnly).toBe(0);
	});

	it("pairs an HTML article with a .reader", () => {
		// 5,479 of 5,524 exported files are HTML, so this is the case that decides whether an
		// import is worth running at all.
		const plan = planImport([doc()], { ...FOLDERS, zipEntries: ["Wild Mushrooming (01h).html"] });

		expect(plan.writes[0].documentPath).toBe("Sources/_documents/Wild Mushrooming (01h).html");
		expect(plan.writes[0].readerPath).toBe("Sources/_documents/Wild Mushrooming (01h).reader");
		expect(plan.linkOnly).toBe(0);
	});

	it("still refuses a format Reader cannot render", () => {
		const plan = planImport([doc()], { ...FOLDERS, zipEntries: ["Wild Mushrooming (01h).docx"] });

		expect(plan.writes[0].documentPath).toBe("Sources/_documents/Wild Mushrooming (01h).docx");
		expect(plan.writes[0].readerPath).toBeUndefined();
		expect(plan.linkOnly).toBe(1);
	});

	it("still writes a note when the export has no file for it", () => {
		const plan = planImport([doc()], { ...FOLDERS, zipEntries: [] });

		expect(plan.writes).toHaveLength(1);
		expect(plan.writes[0].documentPath).toBeUndefined();
		expect(plan.linkOnly).toBe(1);
	});

	it("matches a zip entry on the id, not the title", () => {
		// Readwise sanitises titles for a filesystem, so two documents can share a mangled one.
		const plan = planImport([doc({ id: "abc", title: "Renamed Since" })], {
			...FOLDERS,
			zipEntries: ["Whatever It Was Called (abc).epub"],
		});

		expect(plan.writes[0].readerPath).toBe("Sources/_documents/Renamed Since (abc).reader");
	});

	it("leaves the feed out", () => {
		const plan = planImport([doc(), doc({ id: "02h", location: "feed" })], FOLDERS);

		expect(plan.writes).toHaveLength(1);
		expect(plan.filteredOut).toBe(1);
	});

	it("takes the feed when asked", () => {
		const plan = planImport([doc({ location: "feed" })], { ...FOLDERS, includeFeed: true });
		expect(plan.writes).toHaveLength(1);
	});

	it("skips a document whose note already exists", () => {
		/*
		 * Never merged. By a second run the note may have clips and prose under them; the export
		 * cannot know that, and the only safe reading of "already imported" is "leave it alone".
		 * A library this size guarantees the first attempt gets interrupted.
		 */
		const plan = planImport([doc()], {
			...FOLDERS,
			existingNotes: new Set(["Sources/Wild Mushrooming (01h).md"]),
		});

		expect(plan.writes).toEqual([]);
		expect(plan.alreadyImported).toBe(1);
	});

	it("is idempotent: replanning against its own output writes nothing", () => {
		const first = planImport([doc(), doc({ id: "02h" })], FOLDERS);
		const written = new Set(first.writes.map((w) => w.notePath));
		const second = planImport([doc(), doc({ id: "02h" })], { ...FOLDERS, existingNotes: written });

		expect(second.writes).toEqual([]);
		expect(second.alreadyImported).toBe(2);
	});

	it("works with no folders configured", () => {
		const plan = planImport([doc()], { sourcesFolder: "", documentsFolder: "" });
		expect(plan.writes[0].notePath).toBe("Wild Mushrooming (01h).md");
	});

	it("never plans two documents onto one note", () => {
		// Titles collide once sanitised; the id in the filename is what keeps them apart.
		const plan = planImport([doc({ id: "a", title: "Stats: a primer" }), doc({ id: "b", title: "Stats/a primer" })], FOLDERS);

		expect(new Set(plan.writes.map((w) => w.notePath)).size).toBe(2);
	});
});

describe("describePlan", () => {
	it("accounts for every document", () => {
		const plan = planImport([doc(), doc({ id: "02h", location: "feed" })], {
			...FOLDERS,
			zipEntries: ["Wild Mushrooming (01h).pdf"],
		});

		expect(describePlan(plan)).toBe("1 note, 1 openable in Reader, 1 skipped");
	});
});

/**
 * The real export, which is the only place the CSV's actual shape is settled.
 *
 * Gitignored, so this skips where it is absent — loudly, because a silently skipped test that
 * reports green is how this suite once stopped exercising the PDF extractor entirely.
 */
const hasReal = existsSync(REAL);
if (!hasReal) {
	console.warn("\n  ⚠  test/private/readwise/export.csv is absent — real-export planning tests SKIPPED.\n");
}

(hasReal ? describe : describe.skip)("planning the real export", () => {
	const documents = () => parseExport(readFileSync(REAL, "utf8"));

	it("plans roughly two thousand notes, not five and a half", () => {
		// The difference is the feed. Importing it wholesale is v1's bulk-extraction mistake at
		// this scale, which is the whole reason this plugin exists.
		const plan = planImport(documents(), FOLDERS);

		expect(plan.writes.length).toBeGreaterThan(1000);
		expect(plan.writes.length).toBeLessThan(2500);
		expect(plan.filteredOut).toBeGreaterThan(3000);
	});

	it("gives every planned note a distinct path", () => {
		// Across 5,542 real titles, which is where sanitising collisions would actually appear.
		const plan = planImport(documents(), { ...FOLDERS, includeFeed: true });
		const paths = new Set(plan.writes.map((w) => w.notePath));

		expect(paths.size).toBe(plan.writes.length);
	});

	it("plans no note path that a vault cannot hold", () => {
		const plan = planImport(documents(), { ...FOLDERS, includeFeed: true });
		const bad = plan.writes.filter((w) => /[\\:*?"<>|#^[\]]/.test(w.notePath.slice("Sources/".length)));

		expect(bad.map((w) => w.notePath)).toEqual([]);
	});

	it("is idempotent against the real library", () => {
		const all = documents();
		const first = planImport(all, FOLDERS);
		const second = planImport(all, {
			...FOLDERS,
			existingNotes: new Set(first.writes.map((w) => w.notePath)),
		});

		expect(second.writes).toEqual([]);
		expect(second.alreadyImported).toBe(first.writes.length);
	});
});
