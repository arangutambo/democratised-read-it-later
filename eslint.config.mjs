/**
 * Lint against the rules the Obsidian community review actually runs.
 *
 * The review found a pile of things a linter would have caught the moment they were written,
 * which is the argument for having one in the repo rather than discovering them at submission.
 * The Obsidian rules are the point; the type-aware TypeScript rules are here because half of
 * what the review flagged — unsafe `any`, pointless assertions — needs type information to see.
 */

import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"dist/**",
			"*.cjs",
			".*.cjs",
			"esbuild.config.mjs",
			"eslint.config.mjs",
			"vitest.config.ts",
			"scripts/**/*.mjs",
		],
	},

	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,

	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// TypeScript resolves identifiers itself, and does it better: `no-undef` does not
			// know about DOM lib types and reports every `window` and `HTMLElement` as undefined.
			"no-undef": "off",
		},
	},

	/*
	 * `tools/` and `test/` are not the plugin.
	 *
	 * Nothing in them reaches `main.js` — they are Node scripts run from npm scripts and a test
	 * suite run by vitest. Printing to the console is what a command-line tool is *for*, and
	 * importing `node:fs` from a script that only ever runs under Node is correct rather than a
	 * mobile-compatibility problem. The type-safety rules still apply: those catch real bugs
	 * wherever the code runs.
	 */
	{
		files: ["tools/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/prefer-create-el": "off",
			"obsidianmd/no-static-styles-assignment": "off",
			"obsidianmd/prefer-window-timers": "off",
		},
	},

	/*
	 * The modules that need Node, and why the rule stays off for them.
	 *
	 * Every form was measured against the rule itself: a static import is reported once, a
	 * guarded `require()` twice (the second rule forbids `require` outright), and a guarded
	 * dynamic `import()` once — but that one does not survive esbuild as anything the renderer
	 * can load. The rule fires on the module's name, so nothing satisfies it short of not
	 * touching the filesystem, which would mean dropping the Apple Books and Zotero importers
	 * and the ability to read a file from outside the vault.
	 *
	 * So the static import stays, and the safety property is enforced instead: each of these
	 * calls `assertDesktop()` at load, and an architecture test fails if one stops.
	 */
	{
		files: [
			"src/reader/external-file.ts",
			"src/sources/books/db.ts",
			"src/sources/sqlite.ts",
			"src/sources/zotero/db.ts",
			"src/sources/zotero/lookup.ts",
		],
		rules: { "obsidianmd/no-nodejs-modules": "off" },
	},

	/*
	 * Sentence case, off — after fixing the two it was right about.
	 *
	 * The rule cannot tell UI prose from the strings that only look like it, and the community
	 * review did not raise it. Its remaining hits are all things that would be actively wrong
	 * to change: the API-key placeholder `sk-ant-…`, the example path `/Users/you/Library`, the
	 * colour `#ffd60a`, `https://www.youtube.com/watch?v=…`, the key name `Enter`, and the
	 * proper nouns "Apple Books" and "Reader" — which is this plugin's own name.
	 */
	{
		files: ["src/**/*.ts"],
		rules: { "obsidianmd/ui/sentence-case": "off" },
	},

	/*
	 * The sanitiser and the article parser take a `Document` and nothing else.
	 *
	 * That is deliberate — it is how they are tested against happy-dom without Obsidian in the
	 * room — and the rule's preferred form is, for a document, wrong. `doc.createEl("img")`
	 * lints clean and **throws**: `createEl` is declared on `Node` and appends to the node it is
	 * called on, so on a Document it raises
	 * `HierarchyRequestError: Only one element on document allowed`. Verified in a real window.
	 *
	 * The form that does work, `doc.win.createEl(…)`, needs `win` — an Obsidian augmentation a
	 * parsed document does not have outside the app, so it cannot be tested without shimming
	 * the thing under test. That was tried and reverted; `createElement` is correct here.
	 */
	{
		files: ["src/web/*.ts", "src/epub/*.ts"],
		rules: { "obsidianmd/prefer-create-el": "off" },
	},

	{
		files: ["test/**/*.ts"],
		rules: {
			// A test fake stands in for a browser API; typing it as the real thing is the point.
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-implied-eval": "off",
			// A spy references a method without calling it; that is what a spy is.
			"@typescript-eslint/unbound-method": "off",
		},
	},
);
