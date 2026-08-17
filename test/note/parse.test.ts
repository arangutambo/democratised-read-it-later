import { describe, expect, it } from "vitest";

import { parseClips } from "../../src/note/parse";

/**
 * The note is authoritative for what exists, so anything needing to know which clips a
 * document has asks the note rather than `.reader` — which knows only where each came from.
 */
describe("parseClips", () => {
	it("finds an image clip and its path", () => {
		const clips = parseClips("- ![[Sources/_assets/w/p3-a7f3.png]] ^hl-01k9aaa\n\t\n");

		expect(clips).toHaveLength(1);
		expect(clips[0]).toMatchObject({
			id: "01k9aaa",
			kind: "image",
			assetPath: "Sources/_assets/w/p3-a7f3.png",
			label: "p3-a7f3.png",
		});
	});

	it("finds a quote clip and its text", () => {
		const clips = parseClips("- > Gibbs sampling converges. ^hl-01k9bbb\n\t\n");

		expect(clips[0]).toMatchObject({ id: "01k9bbb", kind: "quote" });
		expect(clips[0].label).toBe("Gibbs sampling converges.");
	});

	it("reads a multi-line quote whose id sits on the last line", () => {
		// Structured quotes put the id on their final continuation line, so a scan anchored to
		// the bullet would miss them entirely.
		const note = "- > A model and algorithm\n\t> - has a bias\n\t> - has variance ^hl-01k9ccc\n\t\n";
		const clips = parseClips(note);

		expect(clips).toHaveLength(1);
		expect(clips[0].label).toBe("A model and algorithm - has a bias - has variance");
		expect(clips[0].line).toBe(0);
	});

	it("returns clips in the order the note reads", () => {
		const note =
			"- > first ^hl-aaa\n\t\n\n- ![[b.png]] ^hl-bbb\n\t\n\n- > third ^hl-ccc\n\t\n";
		expect(parseClips(note).map((c) => c.id)).toEqual(["aaa", "bbb", "ccc"]);
	});

	it("ignores prose and block ids that are not ours", () => {
		const note = "# Heading\n\nSome prose I wrote. ^my-own-anchor\n\n- > clipped ^hl-aaa\n\t\n";
		expect(parseClips(note).map((c) => c.id)).toEqual(["aaa"]);
	});

	it("reports the line the bullet starts on, not the line the id is on", () => {
		const note = "# Heading\n\n- > one\n\t> - two ^hl-aaa\n\t\n";
		expect(parseClips(note)[0].line).toBe(2);
	});

	it("copes with an empty note", () => {
		expect(parseClips("")).toEqual([]);
	});
});
