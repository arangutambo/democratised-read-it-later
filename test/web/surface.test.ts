/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from "vitest";

import { WebSurface } from "../../src/web/surface";
import { BLOCKED_IMAGE_CLASS } from "../../src/web/sanitise";

/** A Readwise export's actual shape: a body fragment whose images are all remote. */
const ARTICLE =
	"<p>The lede.</p>" +
	'<figure><img alt="a meme" src="https://cdn.example.com/meme.png"/></figure>' +
	"<h2>First</h2><p>One.</p>" +
	"<h2>Second</h2><p>Two.</p>";

describe("WebSurface", () => {
	it("opens an article as sections", () => {
		expect(WebSurface.open(ARTICLE).count).toBe(3);
	});

	it("reports that a section is not a page", () => {
		// Key 3 has no meaning here, and says so rather than inventing a screenshot.
		expect(WebSurface.open(ARTICLE).wholeSurfaceIsClippable).toBe(false);
	});

	it("refuses to rasterise, naming what to do instead", async () => {
		await expect(WebSurface.open(ARTICLE).renderRegion(1, [0, 0, 1, 1], 150)).rejects.toThrow(/not a page/i);
	});

	it("gives the table of contents from the headings", () => {
		expect(WebSurface.open(ARTICLE).outline().map((entry) => entry.title)).toEqual(["First", "Second"]);
	});

	it("renders a section", () => {
		const { element } = WebSurface.open(ARTICLE).renderSection(2);
		expect(element.textContent).toContain("One.");
	});

	it("clamps a section index rather than throwing", () => {
		const surface = WebSurface.open(ARTICLE);

		expect(surface.renderSection(0).element.textContent).toContain("The lede");
		expect(surface.renderSection(99).element.textContent).toContain("Two.");
	});

	it("gives a section's plain text for search and quote context", () => {
		expect(WebSurface.open(ARTICLE).sectionText(2)).toBe("First One.");
	});
});

describe("WebSurface and remote images", () => {
	it("fetches nothing on open", () => {
		/*
		 * The whole privacy question for this milestone. Every image in a real export is on
		 * someone else's CDN, so rendering one tells that host your IP and the moment you
		 * opened the article — which is how a tracking pixel works.
		 */
		const surface = WebSurface.open(ARTICLE);
		const { element } = surface.renderSection(1);

		expect(surface.imagesLoaded).toBe(false);
		expect(element.querySelector("img")).toBeNull();
		expect(element.querySelector(`.${BLOCKED_IMAGE_CLASS}`)).not.toBeNull();
	});

	it("names the host on the placeholder, so the choice is informed", () => {
		const { element } = WebSurface.open(ARTICLE).renderSection(1);
		expect(element.querySelector(`.${BLOCKED_IMAGE_CLASS}`)?.textContent).toContain("cdn.example.com");
	});

	it("knows whether there is anything to load at all", () => {
		expect(WebSurface.open(ARTICLE).hasRemoteImages).toBe(true);
		expect(WebSurface.open("<p>no pictures here</p>").hasRemoteImages).toBe(false);
	});

	it("loads images once asked, and says so", () => {
		const surface = WebSurface.open(ARTICLE);
		surface.loadImages();

		expect(surface.imagesLoaded).toBe(true);
		expect(surface.renderSection(1).element.querySelector("img")).not.toBeNull();
	});

	it("re-renders an already-rendered section with its images", () => {
		// The view redraws after loading rather than reopening the document.
		const surface = WebSurface.open(ARTICLE);
		surface.renderSection(1);
		surface.loadImages();

		expect(surface.renderSection(1).element.querySelector("img")).not.toBeNull();
	});

	it("starts blocked again for a freshly opened document", () => {
		// Consenting to fetch from one publisher's CDN is not consent to fetch from every one.
		const first = WebSurface.open(ARTICLE);
		first.loadImages();

		expect(WebSurface.open(ARTICLE).imagesLoaded).toBe(false);
	});
});
