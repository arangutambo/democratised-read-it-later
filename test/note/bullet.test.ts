import { describe, expect, it } from "vitest";

import { appendBullet, renderBullet } from "../../src/note/bullet";
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

	it("leaves an indented line underneath for your own prose", () => {
		const lines = renderBullet(quoteClip("anything")).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe("\t");
	});

	it("keeps a wrapped quote on one line", () => {
		// A PDF text layer emits a newline per line box. Left alone, the second line escapes
		// the bullet and renders as body text.
		const out = renderBullet(quoteClip("first line\n   second line"));
		expect(out).toContain("- > first line second line");
		expect(out.split("\n")).toHaveLength(2);
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
		expect(appendBullet("", quoteClip("first"))).toBe("- > first ^hl-01k9abcdefghjkmnpqrstvwxyz\n\t\n");
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
		expect(out).toContain("prose with no trailing newline\n\n- > clipped");
	});
});
