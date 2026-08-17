/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from "vitest";

import { outlineOf, parseArticle, sectionText } from "../../src/web/article";
import { BLOCKED_IMAGE_CLASS, hostOf, sanitiseArticle } from "../../src/web/sanitise";

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

/** A Readwise export's actual shape: a body fragment, opening on a paragraph. */
const FRAGMENT =
	"<p>Welcome to the beta.</p>" +
	'<figure><img alt="a meme" src="https://s3.amazonaws.com/readwiseio/meme.png"/></figure>' +
	"<h2>Keyboard shortcuts</h2>" +
	"<p>Use the arrow keys.</p>" +
	"<h2>Filtering</h2>" +
	"<p>Filters are saved searches.</p>";

describe("parseArticle", () => {
	it("reads a body fragment, which is what an export actually contains", () => {
		// No <html>, no <head>, no <title> — the first byte is <p>. Verified across 5,479 files.
		const article = parseArticle(FRAGMENT, parse);
		expect(article.sections.length).toBeGreaterThan(1);
	});

	it("keeps the text before the first heading", () => {
		// An article opens with a paragraph; dropping it would lose the lede every time.
		const article = parseArticle(FRAGMENT, parse);

		expect(article.sections[0].title).toBeUndefined();
		expect(sectionText(article.sections[0])).toContain("Welcome to the beta");
	});

	it("splits on headings so the virtualiser has something to work with", () => {
		// One real exported article is 128 KB; a single element defeats the whole point.
		const article = parseArticle(FRAGMENT, parse);
		const titles = article.sections.map((section) => section.title);

		expect(titles).toEqual([undefined, "Keyboard shortcuts", "Filtering"]);
	});

	it("does not split on h3, which is structure within a read", () => {
		const article = parseArticle("<h2>One</h2><h3>Sub</h3><p>x</p>", parse);

		expect(article.sections).toHaveLength(1);
		expect(sectionText(article.sections[0])).toContain("Sub");
	});

	it("takes a title from <title> when the document is a whole page", () => {
		const article = parseArticle("<html><head><title>Real Page</title></head><body><p>x</p></body></html>", parse);
		expect(article.title).toBe("Real Page");
	});

	it("falls back to the first h1 when there is no <title>", () => {
		expect(parseArticle("<h1>The Heading</h1><p>x</p>", parse).title).toBe("The Heading");
	});

	it("has no title for a fragment that has no heading, rather than inventing one", () => {
		// The caller knows it — from the CSV, or from the filename.
		expect(parseArticle("<p>Just prose.</p>", parse).title).toBeUndefined();
	});

	it("gives an empty document one empty section", () => {
		// So the view has something to render and something to say, rather than crashing.
		const article = parseArticle("", parse);
		expect(article.sections).toHaveLength(1);
		expect(sectionText(article.sections[0])).toBe("");
	});

	it("numbers sections from one", () => {
		expect(parseArticle(FRAGMENT, parse).sections.map((s) => s.index)).toEqual([1, 2, 3]);
	});

	it("does not consume the source document, so sections can be re-rendered", () => {
		const article = parseArticle(FRAGMENT, parse);
		expect(sectionText(article.sections[1])).toContain("arrow keys");
		expect(sectionText(article.sections[1])).toContain("arrow keys");
	});
});

describe("outlineOf", () => {
	it("is the headings, pointing at their sections", () => {
		expect(outlineOf(parseArticle(FRAGMENT, parse).sections)).toEqual([
			{ title: "Keyboard shortcuts", depth: 1, page: 2 },
			{ title: "Filtering", depth: 1, page: 3 },
		]);
	});

	it("leaves out the untitled lede, which is not a heading", () => {
		expect(outlineOf(parseArticle("<p>x</p>", parse).sections)).toEqual([]);
	});
});

describe("hostOf", () => {
	it("names who would be contacted", () => {
		expect(hostOf("https://s3.amazonaws.com/readwiseio/meme.png")).toBe("s3.amazonaws.com");
	});

	it("says something rather than nothing for a src it cannot read", () => {
		expect(hostOf("not-a-url")).toBe("elsewhere");
	});
});

describe("sanitiseArticle", () => {
	const sectionOf = (html: string) => {
		const doc = parse("<body></body>");
		return { section: parseArticle(html, parse).sections[0], doc };
	};

	it("blocks a remote image by default and says where it came from", () => {
		/*
		 * Every image in a real export is an absolute URL on someone else's CDN. Rendering one
		 * tells that host your IP and the moment you opened the article, which is a network
		 * decision made on your behalf — and is exactly how a tracking pixel works.
		 */
		const { section, doc } = sectionOf('<p><img src="https://cdn.example.com/x.png"></p>');
		const out = sanitiseArticle(section.body, doc);

		expect(out.querySelector("img")).toBeNull();

		const placeholder = out.querySelector(`.${BLOCKED_IMAGE_CLASS}`);
		expect(placeholder?.textContent).toContain("cdn.example.com");
		expect((placeholder as HTMLElement).dataset.readerRemote).toBe("https://cdn.example.com/x.png");
	});

	it("loads remote images when asked", () => {
		const { section, doc } = sectionOf('<p><img src="https://cdn.example.com/x.png"></p>');
		const out = sanitiseArticle(section.body, doc, { loadRemoteImages: true });

		expect(out.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example.com/x.png");
		expect(out.querySelector(`.${BLOCKED_IMAGE_CLASS}`)).toBeNull();
	});

	it("does not tell the host which page the image was on", () => {
		const { section, doc } = sectionOf('<p><img src="https://cdn.example.com/x.png"></p>');
		const out = sanitiseArticle(section.body, doc, { loadRemoteImages: true });

		expect(out.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
	});

	it("strips a script even when images are allowed", () => {
		// Consenting to load pictures is not consenting to run someone's code.
		const { section, doc } = sectionOf("<p>hi</p><script>window.x=1</script>");
		const out = sanitiseArticle(section.body, doc, { loadRemoteImages: true });

		expect(out.querySelector("script")).toBeNull();
		expect(out.textContent).toContain("hi");
	});

	it("strips an event handler", () => {
		const { section, doc } = sectionOf('<p onclick="steal()">hi</p>');
		const out = sanitiseArticle(section.body, doc);

		expect(out.querySelector("p")?.getAttribute("onclick")).toBeNull();
		expect(out.textContent).toContain("hi");
	});

	it("defuses a javascript: link", () => {
		const { section, doc } = sectionOf('<a href="javascript:steal()">click</a>');
		const out = sanitiseArticle(section.body, doc);

		expect(out.querySelector("a")?.getAttribute("href")).toBeNull();
	});

	it("opens an external link away from this window", () => {
		const { section, doc } = sectionOf('<a href="https://example.com">click</a>');
		const out = sanitiseArticle(section.body, doc);

		expect(out.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("keeps the words inside an element it does not recognise", () => {
		const { section, doc } = sectionOf("<my-widget><p>real text</p></my-widget>");
		expect(sanitiseArticle(section.body, doc).textContent).toContain("real text");
	});

	it("leaves the section it was given alone", () => {
		// Sections are re-rendered when images are loaded, so sanitising must not be destructive.
		const { section, doc } = sectionOf('<p><img src="https://cdn.example.com/x.png"></p>');
		sanitiseArticle(section.body, doc);

		expect(section.body.querySelector("img")).not.toBeNull();
	});
});

describe("splitting a long article that has no headings", () => {
	/*
	 * The corpus this exists for: of 291 real saved articles only 13 contain an h1 or h2, while
	 * the median article is 38 KB and the largest 772 KB. Heading-based splitting alone hands
	 * the virtualiser one enormous element for almost everything.
	 */
	const long = (blocks: number) => "<p>para</p>".repeat(blocks);

	it("splits a headingless run into renderable pieces", () => {
		const article = parseArticle(long(200), parse);

		expect(article.sections.length).toBeGreaterThan(1);
		expect(article.sections.every((section) => sectionText(section) !== "")).toBe(true);
	});

	it("leaves a median-sized article in one piece", () => {
		expect(parseArticle(long(30), parse).sections).toHaveLength(1);
	});

	it("keeps every word when it splits", () => {
		const article = parseArticle(long(200), parse);
		const total = article.sections.map(sectionText).join(" ");

		expect(total.match(/para/g)).toHaveLength(200);
	});

	it("does not put a size split in the table of contents", () => {
		// A continuation is not a heading and must not pretend to be one.
		expect(outlineOf(parseArticle(long(200), parse).sections)).toEqual([]);
	});

	it("still starts a new section at a heading", () => {
		const article = parseArticle(`${long(50)}<h2>Real Heading</h2><p>x</p>`, parse);
		expect(outlineOf(article.sections).map((entry) => entry.title)).toEqual(["Real Heading"]);
	});
});

describe("seeing through wrappers", () => {
	it("descends into a div that holds the whole article", () => {
		// Otherwise the body has one child, no split ever happens, and the virtualiser is handed
		// the entire page as a single element.
		const article = parseArticle(`<div>${"<p>para</p>".repeat(200)}</div>`, parse);
		expect(article.sections.length).toBeGreaterThan(1);
	});

	it("descends through several nested wrappers", () => {
		const article = parseArticle(`<div><main><article>${"<p>x</p>".repeat(200)}</article></main></div>`, parse);
		expect(article.sections.length).toBeGreaterThan(1);
	});

	it("stops descending where the content actually branches", () => {
		const article = parseArticle("<div><h2>One</h2><p>a</p><h2>Two</h2><p>b</p></div>", parse);
		expect(outlineOf(article.sections).map((entry) => entry.title)).toEqual(["One", "Two"]);
	});

	it("does not descend into a paragraph", () => {
		/*
		 * A Readwise YouTube transcript is one enormous <p> of per-phrase spans — 772 KB in the
		 * largest of them. Treating that <p> as a wrapper would cut the document into fragments
		 * of sentences. Transcripts are a document type of their own.
		 */
		const transcript = `<p>${'<span data-rw-start="1">phrase </span>'.repeat(200)}</p>`;
		expect(parseArticle(transcript, parse).sections).toHaveLength(1);
	});
});

describe("sectionText", () => {
	it("does not fuse words across block boundaries", () => {
		/*
		 * `textContent` concatenates without regard for layout, so a heading followed by a
		 * paragraph came back as `FirstOne.` — one word where there were two. This string is a
		 * quote's prefix and suffix and the corpus search matches against, so a fused word means
		 * an anchor that cannot be found. The same bug had to be fixed once for PDF line joins.
		 */
		const article = parseArticle("<h2>First</h2><p>One.</p>", parse);
		expect(sectionText(article.sections[0])).toBe("First One.");
	});

	it("separates list items", () => {
		const article = parseArticle("<ul><li>alpha</li><li>beta</li></ul>", parse);
		expect(sectionText(article.sections[0])).toBe("alpha beta");
	});

	it("separates table cells", () => {
		const article = parseArticle("<table><tr><td>left</td><td>right</td></tr></table>", parse);
		expect(sectionText(article.sections[0])).toBe("left right");
	});

	it("breaks a line at <br>", () => {
		expect(sectionText(parseArticle("<p>one<br>two</p>", parse).sections[0])).toBe("one two");
	});

	it("does not insert a space inside a styled word", () => {
		// Inline elements are not boundaries; splitting there would be the opposite bug.
		expect(sectionText(parseArticle("<p>anti<em>dis</em>establishment</p>", parse).sections[0])).toBe(
			"antidisestablishment",
		);
	});

	it("collapses the whitespace it introduces", () => {
		expect(sectionText(parseArticle("<div><p>a</p><p>b</p></div>", parse).sections[0])).toBe("a b");
	});
});
