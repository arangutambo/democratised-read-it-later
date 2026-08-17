/**
 * @vitest-environment happy-dom
 *
 * A book's markup is arbitrary HTML from a stranger, rendered inside an app that has Node and
 * the whole vault. The sanitiser is therefore a security boundary, and these are the tests
 * that say so.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseXml } from "../../src/epub/parse-xml";
import { sanitiseSection } from "../../src/epub/sanitise";
import { EpubSurface } from "../../src/epub/surface";

const FIXTURE = path.resolve(process.cwd(), "test/fixtures/sample.epub");
const REAL_DIR = path.resolve(process.cwd(), "test/private/epub");

/** Object URLs do not exist in happy-dom; the surface only needs them to be strings. */
if (typeof URL.createObjectURL !== "function") {
	let n = 0;
	URL.createObjectURL = () => `blob:test/${n++}`;
	URL.revokeObjectURL = () => {};
}

function sanitise(html: string, resolveImage: (src: string) => string | undefined = () => "blob:x") {
	const doc = parseXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	return sanitiseSection(doc as unknown as Document, { resolveImage }).innerHTML;
}

describe("sanitiseSection", () => {
	it("keeps the markup that carries a book's meaning", () => {
		const out = sanitise("<h1>Title</h1><p>A <em>word</em> and a <strong>claim</strong>.</p>");

		expect(out).toContain("<h1");
		expect(out).toContain("<em");
		expect(out).toContain("<strong");
	});

	it("removes a script entirely, contents and all", () => {
		expect(sanitise("<p>before</p><script>alert(1)</script><p>after</p>")).not.toContain("alert");
	});

	it("removes every event handler", () => {
		// The attack that needs no script tag at all.
		const out = sanitise('<p onclick="alert(1)" onmouseover="alert(2)">text</p>');

		expect(out).not.toContain("onclick");
		expect(out).not.toContain("onmouseover");
		expect(out).toContain("text");
	});

	it("strips a javascript: link but keeps its words", () => {
		const out = sanitise('<a href="javascript:alert(1)">click me</a>');

		expect(out).not.toContain("javascript:");
		expect(out).toContain("click me");
	});

	it("strips a file: link, which inside Electron reaches the filesystem", () => {
		expect(sanitise('<a href="file:///etc/passwd">x</a>')).not.toContain("file:");
	});

	it("opens an external link in a new window, and severs opener access", () => {
		const out = sanitise('<a href="https://example.com">x</a>');

		expect(out).toContain('target="_blank"');
		expect(out).toContain("noopener");
	});

	it("drops a remote image, which would tell a publisher when the book was read", () => {
		expect(sanitise('<img src="https://tracker.example/pixel.gif"/>')).not.toContain("img");
	});

	it("drops an image that is not in the archive", () => {
		expect(sanitise('<img src="missing.png"/>', () => undefined)).not.toContain("img");
	});

	it("rewrites an archive image and remembers where it came from", () => {
		// The original path is what lets a clip of the figure find the file again.
		const out = sanitise('<img src="images/fig1.png"/>', () => "blob:abc");

		expect(out).toContain("blob:abc");
		expect(out).toMatch(/data-reader-src="images\/fig1\.png"/);
	});

	it("removes styles and stylesheets, so a book cannot restyle the app", () => {
		const out = sanitise('<style>body{display:none}</style><link rel="stylesheet" href="x.css"/><p>text</p>');

		expect(out).not.toContain("display:none");
		expect(out).not.toContain("stylesheet");
		expect(out).toContain("text");
	});

	it("removes an iframe", () => {
		expect(sanitise('<iframe src="https://example.com"></iframe>')).not.toContain("iframe");
	});

	it("keeps the words inside an unknown element rather than deleting them", () => {
		// A book full of custom tags should still read; dropping the subtree loses its text.
		expect(sanitise("<poem><line>Under the spreading chestnut tree</line></poem>")).toContain(
			"chestnut",
		);
	});

	it("keeps an id, which is what an internal link points at", () => {
		expect(sanitise('<h2 id="s2">A subsection</h2>')).toContain('id="s2"');
	});

	it("drops a style attribute, so a book cannot hide its own text", () => {
		expect(sanitise('<p style="color:transparent">hidden</p>')).not.toContain("style=");
	});
});

describe("EpubSurface against the fixture", () => {
	const open = () => EpubSurface.open(new Uint8Array(readFileSync(FIXTURE)));

	it("reports the spine length as its section count", async () => {
		expect((await open()).count).toBe(2);
	});

	it("says a section is not a clippable whole", async () => {
		// There is no page to crop. Key 3 has to report that rather than invent one.
		const surface = await open();
		expect(surface.wholeSurfaceIsClippable).toBe(false);
		await expect(surface.renderRegion(1, [0, 0, 1, 1], 150)).rejects.toThrow(/not a page/);
	});

	it("carries the book's metadata", async () => {
		expect((await open()).title).toBe("A Short Book About Nothing");
	});

	it("renders a section as elements", async () => {
		const { element } = await (await open()).renderSection(1);
		expect(element.textContent).toContain("needle in the haystack");
	});

	it("maps the table of contents onto section numbers", async () => {
		expect((await open()).outline()).toEqual([
			{ title: "One: Beginnings", depth: 0, page: 1 },
			{ title: "A subsection", depth: 1, page: 1 },
			{ title: "Two: Middles", depth: 0, page: 2 },
		]);
	});

	it("gives a section's plain text for search", async () => {
		expect(await (await open()).sectionText(2)).toContain("needle in the haystack");
	});

	it("reads a figure straight out of the archive", async () => {
		/*
		 * The reason a figure clip is not a screenshot: the image is already a file, so the
		 * clip is the publisher's own artwork at full resolution with no DPI decision.
		 */
		const found = await (await open()).readImage(1, "images/fig1.png");

		expect(found?.path).toBe("OEBPS/images/fig1.png");
		expect(Array.from(found?.bytes.subarray(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it("returns nothing for a figure that is not there", async () => {
		expect(await (await open()).readImage(1, "images/nope.png")).toBeUndefined();
	});

	it("clamps a section index outside the book", async () => {
		const surface = await open();
		await expect(surface.renderSection(0)).resolves.toBeDefined();
		await expect(surface.renderSection(999)).resolves.toBeDefined();
	});

	it("releases the object URLs a section created", async () => {
		const revoked: string[] = [];
		const original = URL.revokeObjectURL;
		URL.revokeObjectURL = (url: string) => revoked.push(url);

		const { release } = await (await open()).renderSection(1);
		release();
		URL.revokeObjectURL = original;

		// An object URL keeps its blob alive for the life of the document, so a book read end
		// to end would otherwise hold every image it ever showed.
		expect(revoked.length).toBeGreaterThan(0);
	});
});

const realBooks = existsSync(REAL_DIR)
	? readdirSync(REAL_DIR).filter((name) => name.toLowerCase().endsWith(".epub"))
	: [];

const withBooks = realBooks.length > 0 ? describe : describe.skip;

withBooks("real books", () => {
	for (const name of realBooks) {
		it(`opens and renders the first section of ${name.slice(0, 32)}`, async () => {
			const surface = await EpubSurface.open(new Uint8Array(readFileSync(path.join(REAL_DIR, name))));

			expect(surface.count).toBeGreaterThan(0);

			const { element, release } = await surface.renderSection(1);
			expect(element).toBeDefined();
			release();
		});

		it(`finds readable text somewhere early in ${name.slice(0, 32)}`, async () => {
			// A first section is often a cover with no words, so this looks a little further.
			const surface = await EpubSurface.open(new Uint8Array(readFileSync(path.join(REAL_DIR, name))));

			let text = "";
			for (let i = 1; i <= Math.min(6, surface.count) && text.length < 40; i++) {
				text = await surface.sectionText(i);
			}
			expect(text.length).toBeGreaterThan(40);
		});
	}
});
