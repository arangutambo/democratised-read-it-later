import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeckInboxError, findPdfs, readExternalPdfs } from "../../../src/sources/slides/inbox";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "reader-inbox-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function put(relative: string, contents = "%PDF-1.4\n"): Promise<void> {
	const full = path.join(root, relative);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, contents);
}

describe("findPdfs", () => {
	it("finds PDFs in subfolders, not just the top level", async () => {
		// The real failure: a downloads folder organised into "Lecture Slides" and "Course
		// Materials" reported "no PDFs" while holding twenty of them.
		await put("Lecture Slides/week1.pdf");
		await put("Course Materials/workshop.pdf");
		await put("loose.pdf");

		const found = await findPdfs(root);

		expect(found.map((f) => path.basename(f)).sort()).toEqual(["loose.pdf", "week1.pdf", "workshop.pdf"]);
	});

	it("ignores non-PDFs", async () => {
		await put("notes.txt", "hello");
		await put("script.R", "x <- 1");
		await put("deck.pdf");

		expect(await findPdfs(root)).toHaveLength(1);
	});

	it("matches the extension case-insensitively", async () => {
		await put("SHOUTY.PDF");
		expect(await findPdfs(root)).toHaveLength(1);
	});

	it("skips dotfolders", async () => {
		await put(".Trash/deleted.pdf");
		await put("kept.pdf");

		expect(await findPdfs(root).then((f) => f.map((x) => path.basename(x)))).toEqual(["kept.pdf"]);
	});

	it("stops at the depth limit rather than walking a whole drive", async () => {
		await put("a/b/c/d/deep.pdf");
		await put("a/shallow.pdf");

		const found = await findPdfs(root);

		expect(found.map((f) => path.basename(f))).toEqual(["shallow.pdf"]);
	});

	it("returns a stable order", async () => {
		await put("b.pdf");
		await put("a.pdf");
		await put("Z/z.pdf");

		expect(await findPdfs(root)).toEqual(await findPdfs(root));
	});

	it("reports a missing folder usefully", async () => {
		await expect(findPdfs(path.join(root, "nope"))).rejects.toBeInstanceOf(DeckInboxError);
	});

	it("returns nothing for an empty folder", async () => {
		expect(await findPdfs(root)).toEqual([]);
	});
});

describe("readExternalPdfs", () => {
	it("reads each file's bytes with its own name", async () => {
		await put("Course Materials/handout.pdf", "%PDF-1.7 body");

		const [file] = await readExternalPdfs(root);

		expect(file.fileName).toBe("handout.pdf");
		expect(new TextDecoder().decode(file.data)).toContain("%PDF-1.7");
	});
});
