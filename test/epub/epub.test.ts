/**
 * @vitest-environment happy-dom
 *
 * The package document is XML, and parsing it needs a real `DOMParser` with working CSS
 * selectors — `:scope > li` is what expresses a navigation document's nesting. Obsidian has
 * one; Node does not. `happy-dom` is a devDependency and is never shipped, the same
 * arrangement as `pdfjs-dist`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	dirnameOf,
	findRootfile,
	parseNav,
	parsePackage,
	resolveHref,
	type XmlParser,
} from "../../src/epub/package";
import { parseXml } from "../../src/epub/parse-xml";
import { ZipArchive, ZipError } from "../../src/epub/zip";

const parse: XmlParser = (xml) => parseXml(xml);

const FIXTURE = path.resolve(process.cwd(), "test/fixtures/sample.epub");
const REAL_DIR = path.resolve(process.cwd(), "test/private/epub");

describe("resolveHref", () => {
	it("resolves relative to the file that names it", () => {
		// `text/ch2.xhtml` in an OPF at `OEBPS/content.opf` is `OEBPS/text/ch2.xhtml`.
		expect(resolveHref("OEBPS", "text/ch2.xhtml")).toBe("OEBPS/text/ch2.xhtml");
	});

	it("walks up for a parent reference", () => {
		// A chapter in a subfolder linking to `../images/fig.png` means exactly that.
		expect(resolveHref("OEBPS/text", "../images/fig1.png")).toBe("OEBPS/images/fig1.png");
	});

	it("treats a leading slash as archive-absolute", () => {
		expect(resolveHref("OEBPS/text", "/OEBPS/style.css")).toBe("OEBPS/style.css");
	});

	it("drops a fragment, which names a place inside a file rather than a file", () => {
		expect(resolveHref("OEBPS", "ch1.xhtml#s2")).toBe("OEBPS/ch1.xhtml");
	});

	it("decodes an escaped path, because hrefs are percent-encoded and archives are not", () => {
		expect(resolveHref("OEBPS", "text/a%20chapter.xhtml")).toBe("OEBPS/text/a chapter.xhtml");
	});

	it("copes with a package document at the archive root", () => {
		expect(resolveHref("", "ch1.xhtml")).toBe("ch1.xhtml");
	});
});

describe("dirnameOf", () => {
	it("returns the folder", () => {
		expect(dirnameOf("OEBPS/content.opf")).toBe("OEBPS");
	});

	it("is empty at the root", () => {
		expect(dirnameOf("content.opf")).toBe("");
	});
});

describe("ZipArchive against the generated fixture", () => {
	const bytes = () => new Uint8Array(readFileSync(FIXTURE));

	it("lists every entry", () => {
		expect(ZipArchive.open(bytes()).names).toContain("OEBPS/content.opf");
	});

	it("reads a stored entry", async () => {
		// `mimetype` is stored uncompressed and written first — the one EPUB-specific rule in
		// the container format, and a reader that only handles deflate fails on every book.
		expect(await ZipArchive.open(bytes()).readText("mimetype")).toBe("application/epub+zip");
	});

	it("reads a deflated entry", async () => {
		const xml = await ZipArchive.open(bytes()).readText("META-INF/container.xml");
		expect(xml).toContain("OEBPS/content.opf");
	});

	it("reads binary content unchanged", async () => {
		const png = await ZipArchive.open(bytes()).read("OEBPS/images/fig1.png");
		// PNG magic. If the offset maths were wrong this would be anything but.
		expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it("refuses a file that is not an archive", () => {
		expect(() => ZipArchive.open(new Uint8Array(64))).toThrow(ZipError);
	});

	it("reports a missing entry by name", async () => {
		await expect(ZipArchive.open(bytes()).read("nope.xhtml")).rejects.toThrow(/nope/);
	});
});

describe("package parsing against the generated fixture", () => {
	async function open() {
		const zip = ZipArchive.open(new Uint8Array(readFileSync(FIXTURE)));
		const opfPath = findRootfile(await zip.readText("META-INF/container.xml"), parse);
		return { zip, opfPath, pkg: parsePackage(await zip.readText(opfPath), opfPath, parse) };
	}

	it("finds the package document through the container", async () => {
		expect((await open()).opfPath).toBe("OEBPS/content.opf");
	});

	it("reads the metadata", async () => {
		const { pkg } = await open();
		expect(pkg.title).toBe("A Short Book About Nothing");
		expect(pkg.creator).toBe("Ada Placeholder");
	});

	it("takes reading order from the spine, not the manifest", async () => {
		/*
		 * The manifest holds images, stylesheets and the navigation document too. Treating it
		 * as the reading order is how a reader shows you a stylesheet as chapter three.
		 */
		const { pkg } = await open();

		expect(pkg.spine.map((s) => s.path)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/text/ch2.xhtml"]);
		expect(pkg.manifest.size).toBeGreaterThan(pkg.spine.length);
	});

	it("resolves spine paths against the package document's folder", async () => {
		const { pkg } = await open();
		expect(pkg.spine[1].path).toBe("OEBPS/text/ch2.xhtml");
	});

	it("finds the navigation document by its property", async () => {
		expect((await open()).pkg.navPath).toBe("OEBPS/nav.xhtml");
	});

	it("reads the table of contents with its nesting", async () => {
		const { zip, pkg } = await open();
		const nav = parseNav(await zip.readText(pkg.navPath as string), pkg.navPath as string, parse);

		expect(nav.map((e) => [e.title, e.depth])).toEqual([
			["One: Beginnings", 0],
			["A subsection", 1],
			["Two: Middles", 0],
		]);
		expect(nav[2].path).toBe("OEBPS/text/ch2.xhtml");
	});

	it("can read a spine section's text", async () => {
		const { zip, pkg } = await open();
		expect(await zip.readText(pkg.spine[0].path)).toContain("needle in the haystack");
	});
});

/**
 * The real books, which is where format assumptions actually go to die: a 22 MB pharmacology
 * manual, a novel, and two others, each produced by a different toolchain.
 *
 * Gitignored, so this skips where they are absent — loudly, since a silently skipped test that
 * reports green is how this suite once stopped exercising the PDF extractor entirely.
 */
const realBooks = existsSync(REAL_DIR)
	? readdirSync(REAL_DIR).filter((name) => name.toLowerCase().endsWith(".epub"))
	: [];

if (realBooks.length === 0) {
	console.warn("\n  ⚠  No EPUBs in test/private/epub — the real-book tests are SKIPPED.\n");
}

const withBooks = realBooks.length > 0 ? describe : describe.skip;

withBooks("real books", () => {
	for (const name of realBooks) {
		describe(name.slice(0, 40), () => {
			const bytes = () => new Uint8Array(readFileSync(path.join(REAL_DIR, name)));

			it("opens, finds its package document, and has a spine", async () => {
				const zip = ZipArchive.open(bytes());
				const opfPath = findRootfile(await zip.readText("META-INF/container.xml"), parse);
				const pkg = parsePackage(await zip.readText(opfPath), opfPath, parse);

				expect(pkg.spine.length).toBeGreaterThan(0);
				expect(pkg.title ?? "").not.toBe("");
			});

			it("resolves every spine path to an entry that is really there", async () => {
				// The single most likely format bug: a path resolved against the wrong base.
				const zip = ZipArchive.open(bytes());
				const opfPath = findRootfile(await zip.readText("META-INF/container.xml"), parse);
				const pkg = parsePackage(await zip.readText(opfPath), opfPath, parse);

				const missing = pkg.spine.filter((item) => !zip.has(item.path));
				expect(missing.map((m) => m.path)).toEqual([]);
			});

			it("can read its first section as text", async () => {
				const zip = ZipArchive.open(bytes());
				const opfPath = findRootfile(await zip.readText("META-INF/container.xml"), parse);
				const pkg = parsePackage(await zip.readText(opfPath), opfPath, parse);

				expect((await zip.readText(pkg.spine[0].path)).length).toBeGreaterThan(0);
			});
		});
	}
});
