import { describe, expect, it } from "vitest";

import { appendBullet, insertBulletInPageOrder, renderBullet } from "../../src/note/bullet";
import type { Clip } from "../../src/capture/types";

function quoteClip(text: string, overrides: Partial<Clip> = {}): Clip {
	return {
		id: "01K9ABCDEFGHJKMNPQRSTVWXYZ",
		documentId: "doc-1",
		kind: "quote",
		created: "2026-08-14T04:00:00.000Z",
		text,
		locator: {
			surface: { kind: "pdf-page", index: 12 },
			quote: { exact: text, prefix: "before ", suffix: " after" },
		},
		...overrides,
	};
}

function imageClip(assetPath: string): Clip {
	return {
		id: "01K9ZZZZZZZZZZZZZZZZZZZZZZ",
		documentId: "doc-1",
		kind: "image",
		created: "2026-08-14T04:00:00.000Z",
		assetPath,
		locator: {
			surface: { kind: "pdf-page", index: 12 },
			rect: [0.1, 0.2, 0.5, 0.3],
		},
	};
}

describe("renderBullet", () => {
	it("renders a quote as a blockquote inside the bullet", () => {
		const out = renderBullet(quoteClip("Gibbs sampling converges to a local optimum."));
		expect(out).toContain("- > Gibbs sampling converges to a local optimum.");
	});

	it("renders an image as a plain embed", () => {
		const out = renderBullet(imageClip("Sources/_assets/binf7001/p12-a7f3.png"));
		expect(out).toContain("- ![[Sources/_assets/binf7001/p12-a7f3.png]]");
	});

	it("carries a block id so a single clip can be quoted into an essay", () => {
		// ![[Note#^hl-…]] is the point of the whole system — DESIGN.md §3.
		expect(renderBullet(quoteClip("anything"))).toContain("^hl-01k9abcdefghjkmnpqrstvwxyz");
	});

	it("leaves a nested bullet underneath for your own prose", () => {
		// A bullet rather than a bare tab: what you type is a list item in its own right, so it
		// wraps, nests, and Enter gives you another instead of falling out of the list.
		const lines = renderBullet(quoteClip("anything")).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe("\t- ");
	});

	it("keeps a multi-line quote inside one bullet", () => {
		/*
		 * A bulleted slide is a list, and flattening it loses the shape that carried the
		 * meaning. Continuation lines are indented and re-prefixed with `>` so the whole thing
		 * stays one list item and one blockquote rather than escaping into body text.
		 *
		 * The structure comes from `gesture/structure.ts`, which only emits line breaks where
		 * the slide genuinely had list items — prose that merely wrapped is rejoined first.
		 */
		const out = renderBullet(quoteClip("A model and algorithm\n- has a bias\n- has variance"));
		const lines = out.split("\n");

		expect(lines[0]).toBe("- > A model and algorithm");
		expect(lines[1]).toBe("\t> - has a bias");
		expect(lines[2]).toBe("\t> - has variance ^hl-01k9abcdefghjkmnpqrstvwxyz");
		expect(lines[3]).toBe("\t- ");
	});

	it("preserves the indentation of a nested list", () => {
		const out = renderBullet(quoteClip("- outer\n  - inner"));
		expect(out).toContain("\t>   - inner");
	});

	it("puts the block id on the last line, where Obsidian looks for it", () => {
		const out = renderBullet(quoteClip("one\n- two"));
		const lines = out.split("\n");

		expect(lines[0]).not.toContain("^hl-");
		expect(lines[1]).toContain("^hl-01k9abcdefghjkmnpqrstvwxyz");
	});
});

/**
 * The Live Preview contract, made checkable.
 *
 * The requirement was "readable without too much code making it not understandable in this
 * mode". Every one of these is a way that could quietly stop being true.
 */
describe("what must never appear in a bullet", () => {
	const cases: [name: string, clip: Clip][] = [
		["quote", quoteClip("Some quoted sentence from the source.")],
		["image", imageClip("Sources/_assets/binf7001/p12-a7f3.png")],
	];

	for (const [name, clip] of cases) {
		it(`${name}: no page number, rect, or source path from the locator`, () => {
			const out = renderBullet(clip);
			expect(out).not.toContain("page=");
			expect(out).not.toContain("rect=");
			expect(out).not.toContain(".pdf");
			expect(out).not.toMatch(/\b12\b/);
		});

		it(`${name}: no managed-region markers`, () => {
			expect(renderBullet(clip)).not.toContain("%%");
		});

		it(`${name}: no HTML, comments or frontmatter`, () => {
			const out = renderBullet(clip);
			expect(out).not.toMatch(/<[a-z]/i);
			expect(out).not.toContain("<!--");
			expect(out).not.toContain("---");
		});

		it(`${name}: no JSON or key: value metadata`, () => {
			const out = renderBullet(clip);
			expect(out).not.toContain("{");
			expect(out).not.toContain("created");
			expect(out).not.toContain("documentId");
		});
	}
});

describe("appendBullet", () => {
	it("writes into an empty note without a leading blank line", () => {
		expect(appendBullet("", quoteClip("first"))).toBe("- > first ^hl-01k9abcdefghjkmnpqrstvwxyz\n\t- \n");
	});

	it("separates clips with exactly one blank line", () => {
		const once = appendBullet("", quoteClip("first"));
		const twice = appendBullet(once, imageClip("a.png"));

		expect(twice).not.toMatch(/\n{4,}/);
		expect(twice.split("![[a.png]]")).toHaveLength(2);
	});

	it("preserves everything already in the note, including hand-written prose", () => {
		const existing = "# My notes\n\nSome prose I wrote by hand.\n";
		const out = appendBullet(existing, quoteClip("clipped"));

		expect(out.startsWith(existing)).toBe(true);
		expect(out).toContain("Some prose I wrote by hand.");
	});

	it("never rewrites an earlier bullet when appending a later one", () => {
		// Append-only is the whole safety story: with no rewrite path, a hand-edit cannot be
		// clobbered and the note needs no conflict detection at all.
		const first = appendBullet("", quoteClip("original wording"));
		const edited = first.replace("original wording", "wording I trimmed myself");
		const out = appendBullet(edited, quoteClip("second"));

		expect(out).toContain("wording I trimmed myself");
		expect(out).not.toContain("original wording");
	});

	it("tolerates a note the user has left without a trailing newline", () => {
		const out = appendBullet("prose with no trailing newline", quoteClip("clipped"));
		expect(out).toContain("prose with no trailing newline\n- > clipped");
	});
});

/**
 * Clips arrive in the order you make them, which is not the order the document reads in: you
 * clip a figure on page 12, then go back for the definition on page 3. The note has to be
 * readable straight through afterwards.
 *
 * The page comes from `.reader`, never from the note — the Live Preview rule forbids it
 * appearing there, so it cannot be read back out.
 */
describe("insertBulletInPageOrder", () => {
	function onPage(page: number, id: string, text: string, top = 0, left = 0): Clip {
		return quoteClip(text, {
			id,
			locator: { surface: { kind: "pdf-page", index: page }, rect: [left, top, 0.1, 0.05] },
		});
	}

	/** Position for each block id, as `.reader` would report it. */
	function pages(map: Record<string, number | [number, number, number]>) {
		return (blockId: string) => {
			const entry = map[blockId];
			if (entry === undefined) return undefined;
			const [page, top, left] = typeof entry === "number" ? [entry, 0, 0] : entry;
			return { page, top, left };
		};
	}

	it("appends when the clip is later than everything already there", () => {
		const body = "- > page three ^hl-aaa\n\tmy prose\n";
		const { body: out } = insertBulletInPageOrder(body, onPage(9, "BBB", "page nine"), pages({ aaa: 3 }));

		expect(out.indexOf("page three")).toBeLessThan(out.indexOf("page nine"));
	});

	it("inserts before a later clip when you go back in the document", () => {
		const body = "- > page twelve ^hl-aaa\n\tmy prose\n";
		const { body: out } = insertBulletInPageOrder(body, onPage(3, "BBB", "page three"), pages({ aaa: 12 }));

		expect(out.indexOf("page three")).toBeLessThan(out.indexOf("page twelve"));
	});

	it("carries the prose indented under a bullet along with it", () => {
		// The prose belongs to its clip. Inserting must not separate them.
		const body = "- > page twelve ^hl-aaa\n\tthis explains page twelve\n";
		const { body: out } = insertBulletInPageOrder(body, onPage(3, "BBB", "page three"), pages({ aaa: 12 }));
		const lines = out.split("\n");

		const twelve = lines.findIndex((l) => l.includes("page twelve"));
		expect(lines[twelve + 1]).toBe("\tthis explains page twelve");
	});

	it("lands in the middle of a run", () => {
		const body =
			"- > p1 ^hl-aaa\n\t- \n- > p5 ^hl-bbb\n\t- \n- > p9 ^hl-ccc\n\t- \n";
		const { body: out } = insertBulletInPageOrder(
			body,
			onPage(7, "DDD", "p7"),
			pages({ aaa: 1, bbb: 5, ccc: 9 }),
		);

		const order = ["p1", "p5", "p7", "p9"].map((t) => out.indexOf(t));
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("reports the writing line of the clip it just inserted", () => {
		const body = "- > p9 ^hl-aaa\n\t\n";
		const { body: out, line } = insertBulletInPageOrder(body, onPage(3, "BBB", "p3"), pages({ aaa: 9 }));

		// The cursor must land under the new clip, which is no longer the end of the note.
		expect(out.split("\n")[line]).toBe("\t- ");
		expect(out.split("\n")[line - 1]).toContain("p3");
	});

	it("keeps hand-written prose at the top of the note above everything", () => {
		const body = "# My notes\n\nSomething I wrote.\n\n- > p9 ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(body, onPage(3, "BBB", "p3"), pages({ aaa: 9 }));

		expect(out.startsWith("# My notes\n\nSomething I wrote.")).toBe(true);
		expect(out.indexOf("p3")).toBeLessThan(out.indexOf("p9"));
	});

	it("steps over a bullet whose locator is gone rather than piling in front of it", () => {
		// A clip whose .reader entry was lost sorts nowhere. Treating it as page 0 would push
		// every later clip above it.
		const body = "- > orphan ^hl-zzz\n\t\n\n- > p9 ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(body, onPage(3, "BBB", "p3"), pages({ aaa: 9 }));

		expect(out.indexOf("orphan")).toBeLessThan(out.indexOf("p3"));
		expect(out.indexOf("p3")).toBeLessThan(out.indexOf("p9"));
	});

	it("never edits an existing line, only moves it", () => {
		const body = "- > wording I trimmed myself ^hl-aaa\n\tand my prose\n";
		const { body: out } = insertBulletInPageOrder(body, onPage(1, "BBB", "p1"), pages({ aaa: 12 }));

		expect(out).toContain("- > wording I trimmed myself ^hl-aaa");
		expect(out).toContain("\tand my prose");
	});

	it("does not double up blank lines where it cuts in", () => {
		const body = "- > p9 ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(body, onPage(3, "BBB", "p3"), pages({ aaa: 9 }));

		expect(out).not.toMatch(/\n{3,}/);
	});
});

describe("ordering within a page", () => {
	function at(page: number, top: number, left: number, id: string, text: string): Clip {
		return quoteClip(text, {
			id,
			locator: { surface: { kind: "pdf-page", index: page }, rect: [left, top, 0.2, 0.04] },
		});
	}

	const position = (page: number, top: number, left: number) => ({ page, top, left });

	it("puts a clip from higher up the page above one from lower down", () => {
		// You clip the conclusion, then go back for the premise above it.
		const body = "- > bottom of page ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			at(3, 0.1, 0.1, "BBB", "top of page"),
			(id) => (id === "aaa" ? position(3, 0.8, 0.1) : undefined),
		);

		expect(out.indexOf("top of page")).toBeLessThan(out.indexOf("bottom of page"));
	});

	it("reads two columns left to right when they sit on the same line", () => {
		const body = "- > right column ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			at(3, 0.4, 0.1, "BBB", "left column"),
			(id) => (id === "aaa" ? position(3, 0.4, 0.6) : undefined),
		);

		expect(out.indexOf("left column")).toBeLessThan(out.indexOf("right column"));
	});

	it("treats a few pixels of vertical difference as the same line", () => {
		// A selection box and a dragged box across the same row rarely share an exact top.
		const body = "- > drawn second, further right ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			at(3, 0.402, 0.1, "BBB", "further left"),
			(id) => (id === "aaa" ? position(3, 0.4, 0.6) : undefined),
		);

		expect(out.indexOf("further left")).toBeLessThan(out.indexOf("drawn second"));
	});

	it("still sorts by page before position on the page", () => {
		// Top of page 9 must not outrank the bottom of page 3.
		const body = "- > bottom of page three ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			at(9, 0.02, 0.1, "BBB", "top of page nine"),
			(id) => (id === "aaa" ? position(3, 0.95, 0.1) : undefined),
		);

		expect(out.indexOf("bottom of page three")).toBeLessThan(out.indexOf("top of page nine"));
	});

	it("sorts a whole-page clip to the top of its own page", () => {
		// Key 3 stores no rect, so it has no position on the page — the page itself is the clip.
		const wholePage = quoteClip("the whole page", {
			id: "BBB",
			locator: { surface: { kind: "pdf-page", index: 3 } },
		});
		const body = "- > something midway down ^hl-aaa\n\t\n";
		const { body: out } = insertBulletInPageOrder(body, wholePage, (id) =>
			id === "aaa" ? position(3, 0.5, 0.1) : undefined,
		);

		expect(out.indexOf("the whole page")).toBeLessThan(out.indexOf("something midway"));
	});
});

describe("sorting around multi-line quotes", () => {
	function structured(id: string, page: number, text: string): Clip {
		return quoteClip(text, {
			id,
			locator: { surface: { kind: "pdf-page", index: page }, rect: [0.1, 0.1, 0.2, 0.05] },
		});
	}

	it("inserts before a whole bullet, never inside one", () => {
		/*
		 * A multi-line quote carries its block id on the last continuation line. Inserting at
		 * that line would slice the bullet in half, leaving an orphaned blockquote fragment.
		 */
		const body = renderBullet(structured("AAA", 9, "heading\n- point one\n- point two")) + "\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			structured("BBB", 2, "earlier page"),
			(id) => (id === "aaa" ? { page: 9, top: 0.1, left: 0.1 } : undefined),
		);

		const lines = out.split("\n");
		const heading = lines.findIndex((l) => l.includes("heading"));

		expect(out.indexOf("earlier page")).toBeLessThan(out.indexOf("heading"));
		// The three lines of the later bullet are still contiguous and in order.
		expect(lines[heading]).toBe("- > heading");
		expect(lines[heading + 1]).toBe("\t> - point one");
		expect(lines[heading + 2]).toContain("- point two");
	});

	it("still finds a multi-line bullet when sorting", () => {
		// The id regex was anchored to `- `, which made every structured clip invisible to the
		// sort and piled later clips in front of them.
		const body = renderBullet(structured("AAA", 2, "heading\n- point")) + "\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			structured("BBB", 9, "later page"),
			(id) => (id === "aaa" ? { page: 2, top: 0.1, left: 0.1 } : undefined),
		);

		expect(out.indexOf("heading")).toBeLessThan(out.indexOf("later page"));
	});
});

/**
 * Parents, and why their scope runs by position rather than by page.
 *
 * A parent owns everything from its own position until the next parent. In a prose PDF a
 * section's material routinely starts partway down the page before its heading and ends
 * partway down the page after — so "the parent on this page" is the wrong rule.
 */
describe("parents", () => {
	function clipAt(id: string, page: number, top: number, text: string, isParent = false): Clip {
		return quoteClip(text, {
			id,
			...(isParent ? { isParent: true } : {}),
			locator: { surface: { kind: "pdf-page", index: page }, rect: [0.1, top, 0.2, 0.05] },
		});
	}

	/** `.reader` reporting positions and which clips are parents. */
	function positions(map: Record<string, [page: number, top: number, parent?: boolean]>) {
		return (id: string) => {
			const entry = map[id];
			if (!entry) return undefined;
			const [page, top, parent] = entry;
			return { page, top, left: 0.1, ...(parent ? { isParent: true } : {}) };
		};
	}

	it("nests a clip under the parent that precedes it", () => {
		const body = renderBullet(clipAt("AAA", 2, 0.1, "Section one", true)) + "\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			clipAt("BBB", 2, 0.5, "a detail"),
			positions({ aaa: [2, 0.1, true] }),
		);

		expect(out).toContain("- > Section one");
		expect(out).toContain("\t- > a detail");
	});

	it("keeps a parent itself at the top level", () => {
		const body = renderBullet(clipAt("AAA", 2, 0.1, "Section one", true)) + "\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			clipAt("BBB", 5, 0.1, "Section two", true),
			positions({ aaa: [2, 0.1, true] }),
		);

		expect(out).toContain("- > Section two");
		expect(out).not.toContain("\t- > Section two");
	});

	it("puts a clip from an earlier page above the parent, and does not nest it", () => {
		// The rule you asked for: position ordering wins, and an earlier clip belongs to
		// whatever preceded it — here, nothing.
		const body = renderBullet(clipAt("AAA", 5, 0.1, "Section one", true)) + "\n";
		const { body: out } = insertBulletInPageOrder(
			body,
			clipAt("BBB", 2, 0.1, "earlier material"),
			positions({ aaa: [5, 0.1, true] }),
		);

		expect(out.indexOf("earlier material")).toBeLessThan(out.indexOf("Section one"));
		expect(out).toContain("- > earlier material");
		expect(out).not.toContain("\t- > earlier material");
	});

	it("gives material above a later parent to the earlier one", () => {
		/*
		 * The case from a prose PDF: a section heading appears partway down page 5, and the
		 * material above it on that page still belongs to the section that began on page 2.
		 */
		let body = renderBullet(clipAt("AAA", 2, 0.2, "Section one", true)) + "\n";
		body = insertBulletInPageOrder(
			body,
			clipAt("BBB", 5, 0.8, "Section two", true),
			positions({ aaa: [2, 0.2, true] }),
		).body;

		const { body: out } = insertBulletInPageOrder(
			body,
			clipAt("CCC", 5, 0.3, "above the second heading"),
			positions({ aaa: [2, 0.2, true], bbb: [5, 0.8, true] }),
		);

		const lines = out.split("\n");
		const at = lines.findIndex((l) => l.includes("above the second heading"));

		expect(lines[at].startsWith("\t- ")).toBe(true);
		expect(out.indexOf("above the second heading")).toBeLessThan(out.indexOf("Section two"));
	});

	it("supports several parents in one document", () => {
		let body = renderBullet(clipAt("AAA", 1, 0.1, "One", true)) + "\n";
		const known: Record<string, [number, number, boolean?]> = { aaa: [1, 0.1, true] };

		for (const [id, page] of [["BBB", 4], ["CCC", 8]] as const) {
			body = insertBulletInPageOrder(body, clipAt(id, page, 0.1, `Parent ${page}`, true), positions(known)).body;
			known[id.toLowerCase()] = [page, 0.1, true];
		}

		const { body: out } = insertBulletInPageOrder(
			body,
			clipAt("DDD", 6, 0.1, "under the second"),
			positions(known),
		);

		const lines = out.split("\n");
		const at = lines.findIndex((l) => l.includes("under the second"));

		expect(lines[at].startsWith("\t- ")).toBe(true);
		expect(out.indexOf("Parent 4")).toBeLessThan(out.indexOf("under the second"));
		expect(out.indexOf("under the second")).toBeLessThan(out.indexOf("Parent 8"));
	});

	it("puts a child's writing line one level deeper again", () => {
		const body = renderBullet(clipAt("AAA", 2, 0.1, "Section one", true)) + "\n";
		const { body: out, line } = insertBulletInPageOrder(
			body,
			clipAt("BBB", 2, 0.5, "a detail"),
			positions({ aaa: [2, 0.1, true] }),
		);

		expect(out.split("\n")[line]).toBe("\t\t- ");
	});
});

/**
 * Headings from the document's own table of contents.
 *
 * Distinct from parents: a heading is a fact about the document, a parent is a judgement you
 * make. They compose — a parent nests clips under itself, inside whatever section they are in.
 */
describe("sections become headings", () => {
	const SECTIONS = [
		{ title: "1 Vectors", depth: 0, page: 3 },
		{ title: "1.2 Vectors in Rn", depth: 1, page: 14 },
	];

	function onPage(id: string, page: number, text: string): Clip {
		return quoteClip(text, {
			id,
			locator: { surface: { kind: "pdf-page", index: page }, rect: [0.1, 0.2, 0.2, 0.05] },
		});
	}

	it("adds the section chain above the clip", () => {
		const { body: out } = insertBulletInPageOrder(
			"",
			onPage("AAA", 16, "the dot product"),
			() => undefined,
			{ sections: SECTIONS },
		);

		const lines = out.split("\n");
		expect(lines[0]).toBe("## 1 Vectors");
		expect(lines[1]).toBe("### 1.2 Vectors in Rn");
		expect(lines[2]).toContain("the dot product");
	});

	it("does not repeat a heading for a second clip in the same section", () => {
		const first = insertBulletInPageOrder("", onPage("AAA", 16, "one"), () => undefined, {
			sections: SECTIONS,
		}).body;

		const { body: out } = insertBulletInPageOrder(
			first,
			onPage("BBB", 17, "two"),
			(id) => (id === "aaa" ? { page: 16, top: 0.2, left: 0.1 } : undefined),
			{ sections: SECTIONS },
		);

		expect(out.split("## 1 Vectors")).toHaveLength(2);
		expect(out.split("### 1.2 Vectors in Rn")).toHaveLength(2);
	});

	it("leaves the note alone when the document has no outline", () => {
		const { body: out } = insertBulletInPageOrder("", onPage("AAA", 16, "a clip"), () => undefined, {
			sections: [],
		});

		expect(out).not.toContain("#");
	});

	it("keeps a clip's bullet findable underneath its heading", () => {
		// The walk-back that finds a bullet's first line must stop at a heading, or a heading
		// immediately above a multi-line quote would be mistaken for part of it.
		const first = insertBulletInPageOrder("", onPage("AAA", 16, "one"), () => undefined, {
			sections: SECTIONS,
		}).body;

		const { body: out } = insertBulletInPageOrder(
			first,
			onPage("BBB", 4, "earlier"),
			(id) => (id === "aaa" ? { page: 16, top: 0.2, left: 0.1 } : undefined),
			{ sections: [SECTIONS[0]] },
		);

		expect(out.indexOf("earlier")).toBeLessThan(out.indexOf("one"));
	});
});
