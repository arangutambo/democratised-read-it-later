import { describe, expect, it } from "vitest";

import { baseCitekey, blockId, makeCitekey, surnameOf, titleWordOf, titleWordsOf, ulid } from "../../src/core/ids";

const fixedRandom = (bytes: number) => new Uint8Array(bytes).fill(0);

describe("ulid", () => {
	it("is 26 characters of Crockford base32", () => {
		const id = ulid(0, fixedRandom);
		expect(id).toHaveLength(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	it("sorts lexicographically by creation time", () => {
		const early = ulid(1_000_000, fixedRandom);
		const late = ulid(2_000_000, fixedRandom);
		expect(early < late).toBe(true);
	});

	it("produces distinct ids at the same instant", () => {
		const ids = new Set(Array.from({ length: 200 }, () => ulid(1234)));
		expect(ids.size).toBe(200);
	});
});

describe("blockId", () => {
	it("lowercases and prefixes for markdown", () => {
		expect(blockId("01ARZ3NDEK")).toBe("hl-01arz3ndek");
	});
});

describe("surnameOf", () => {
	it.each([
		["Cowan, Nelson", "cowan"],
		["Nelson Cowan", "cowan"],
		["Michael Greger", "greger"],
		// Real strings from the Books library — credentials are not surnames.
		["Michael Greger MD", "greger"],
		["Michael Greger, M.D., FACLM", "greger"],
		["Pease, Barbara", "pease"],
		["Abdaal, Ali", "abdaal"],
		["", ""],
	])("%s → %s", (input, expected) => {
		expect(surnameOf(input)).toBe(expected);
	});

	it("folds diacritics so citekeys stay BibTeX-safe", () => {
		expect(surnameOf("Émile Durkheim")).toBe("durkheim");
		expect(surnameOf("Ångström, Anders")).toBe("angstrom");
	});
});

describe("titleWordOf", () => {
	it("skips leading stopwords", () => {
		expect(titleWordOf("The Psychology of Money")).toBe("psychology");
		expect(titleWordOf("How Not to Diet")).toBe("not");
		expect(titleWordOf("A Brief History")).toBe("brief");
	});

	it("falls back to the first word when everything is a stopword", () => {
		expect(titleWordOf("The A")).toBe("the");
	});

	it("returns empty for an empty title", () => {
		expect(titleWordOf("")).toBe("");
	});
});

describe("titleWordsOf", () => {
	it("returns several meaningful words in order", () => {
		expect(titleWordsOf("The How Not to Die Cookbook", 2)).toEqual(["not", "die"]);
	});

	it("returns what exists when fewer words are available", () => {
		expect(titleWordsOf("Captivate", 2)).toEqual(["captivate"]);
	});
});

describe("baseCitekey", () => {
	it("builds surname + year + first meaningful title word", () => {
		expect(baseCitekey({ author: "Cowan, Nelson", year: 2001, title: "The Magical Number Four" })).toBe(
			"cowan2001magical",
		);
	});

	it("omits missing pieces rather than inventing placeholders", () => {
		expect(baseCitekey({ title: "Captivate" })).toBe("captivate");
	});

	it("uses two title words when no year is available", () => {
		// Apple Books records a year for almost nothing, so one word collapses distinct books.
		expect(baseCitekey({ author: "Michael Greger MD", title: "The How Not to Die Cookbook" })).toBe(
			"gregernotdie",
		);
		expect(baseCitekey({ author: "Michael Greger MD", title: "How Not to Diet" })).toBe("gregernotdiet");
		expect(baseCitekey({ author: "Housel, Morgan", title: "The Psychology of Money" })).toBe(
			"houselpsychologymoney",
		);
	});

	it("keeps to one title word when a year anchors the key", () => {
		expect(baseCitekey({ author: "Cowan, Nelson", year: 2001, title: "The Magical Number Four" })).toBe(
			"cowan2001magical",
		);
	});

	it("tolerates a one-word title when two are wanted", () => {
		expect(baseCitekey({ author: "Van Edwards", title: "Captivate" })).toBe("edwardscaptivate");
	});

	it("is deterministic", () => {
		const parts = { author: "Greene, Robert", year: 2006, title: "The 33 Strategies of War" };
		expect(baseCitekey(parts)).toBe(baseCitekey(parts));
	});

	it("falls back to `untitled` rather than producing an empty key", () => {
		expect(baseCitekey({})).toBe("untitled");
	});
});

describe("makeCitekey", () => {
	it("returns the base when it is free", () => {
		expect(makeCitekey({ author: "Cowan", year: 2001, title: "Magical" }, new Set())).toBe("cowan2001magical");
	});

	it("suffixes alphabetically on collision", () => {
		const taken = new Set(["cowan2001magical"]);
		expect(makeCitekey({ author: "Cowan", year: 2001, title: "Magical" }, taken)).toBe("cowan2001magicala");
	});

	it("keeps going past a run of collisions", () => {
		const taken = new Set(["k", "ka", "kb", "kc"]);
		expect(makeCitekey({ title: "k" }, taken)).toBe("kd");
	});

	it("falls back to numbering when the alphabet runs out", () => {
		const taken = new Set(["k", ...Array.from({ length: 26 }, (_, i) => `k${String.fromCharCode(97 + i)}`)]);
		expect(makeCitekey({ title: "k" }, taken)).toBe("k-2");
	});
});
