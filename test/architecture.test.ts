import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Enforces PLAN.md §3.1, the structural rule the whole test strategy rests on:
 * the pure layers must never import from `obsidian`.
 *
 * Without it the anchoring engine — the riskiest code in the project — becomes untestable
 * outside a running Obsidian instance. The rule is easy to break by accident months from
 * now with a single convenience import, so it is asserted rather than remembered.
 */

const SRC = path.resolve(__dirname, "../src");

/** Layers that must stay free of any Obsidian dependency. */
const PURE_DIRS = ["core", "anchor", "template", "transport", "capture"];

/** Within source adapters, only row-mapping is pure; `db.ts` may touch the vault APIs. */
const PURE_ADAPTER_FILES = ["map.ts"];

/**
 * Individually pure files inside layers that are otherwise allowed to touch Obsidian.
 *
 * `reader/` renders into a live view and must import `obsidian`, but its model, its memory
 * budget and its rect maths are where the risk actually is — and none of that needs a running
 * app to be correct. Keeping these four testable in plain Node is what stops the riskiest
 * code in v2 from being verifiable only by opening Obsidian and squinting.
 */
const PURE_FILES = [
	"note/bullet.ts",
	"reader/document.ts",
	"reader/surface/surface.ts",
	"reader/render/virtualiser.ts",
	"reader/gesture/region.ts",
];

function walk(dir: string): string[] {
	let out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out = out.concat(walk(full));
		else if (full.endsWith(".ts")) out.push(full);
	}
	return out;
}

function pureFiles(): string[] {
	const files = PURE_DIRS.flatMap((dir) => walk(path.join(SRC, dir)));
	const adapters = walk(path.join(SRC, "sources")).filter((f) =>
		PURE_ADAPTER_FILES.includes(path.basename(f)),
	);
	const named = PURE_FILES.map((rel) => path.join(SRC, rel));
	return [...files, ...adapters, ...named];
}

const IMPORTS_OBSIDIAN = /(?:from\s+["']obsidian["']|require\(\s*["']obsidian["']\s*\))/;

/**
 * Strip comments before scanning for forbidden patterns.
 *
 * Without this, a comment *documenting* a banned form trips the very rule it explains —
 * which is exactly what happened the first time this test ran.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("architecture", () => {
	it("keeps the pure layers free of `obsidian` imports", () => {
		const offenders = pureFiles()
			.filter((file) => IMPORTS_OBSIDIAN.test(readFileSync(file, "utf8")))
			.map((file) => path.relative(SRC, file));

		expect(offenders).toEqual([]);
	});

	it("never imports a node builtin dynamically", () => {
		/*
		 * esbuild compiles a *static* import of an external module into `require("node:fs")`,
		 * which Electron resolves natively. A *dynamic* `await import("node:fs")` survives as a
		 * real ESM import, which the renderer treats as a URL fetch and Obsidian's
		 * app://obsidian.md origin turns into a CORS failure. This reached a real Obsidian
		 * window once; it does not get to happen twice.
		 *
		 * Defer evaluation by lazily importing the *local module* that holds the static
		 * imports, not by making the builtin import itself dynamic.
		 */
		const offenders = walk(SRC)
			.filter((file) => /import\s*\(\s*["']node:/.test(stripComments(readFileSync(file, "utf8"))))
			.map((file) => path.relative(SRC, file));

		expect(offenders).toEqual([]);
	});

	it("never imports pdf.js into shipped code", () => {
		// `pdfjs-dist` is a devDependency used to exercise the extraction adapter against real
		// decks in Node. Production uses Obsidian's own bundled copy via window.pdfjsLib;
		// importing the package from src/ would silently add ~1 MB to every user's download.
		const offenders = walk(SRC)
			.filter((file) => /["']pdfjs-dist/.test(stripComments(readFileSync(file, "utf8"))))
			.map((file) => path.relative(SRC, file));

		expect(offenders).toEqual([]);
	});

	it("is actually scanning files, not passing vacuously", () => {
		// A rename that empties PURE_DIRS would otherwise make the test above meaningless.
		expect(pureFiles().length).toBeGreaterThan(0);
	});

	it("every file named in PURE_FILES exists", () => {
		// The named list is the half of the rule a rename can silently disable: a moved file
		// simply stops being scanned, and the suite still reports green. Assert them present
		// rather than skipping the missing ones.
		const missing = PURE_FILES.filter((rel) => !existsSync(path.join(SRC, rel)));
		expect(missing).toEqual([]);
	});
});
