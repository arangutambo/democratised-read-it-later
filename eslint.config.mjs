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
	 * The one place `require()` is right.
	 *
	 * These modules reach Node builtins through `onDesktop()`, which is what the community
	 * review asks for: a `require()` behind a `Platform.isDesktopApp` check, never evaluated on
	 * a platform without Node. It has to be a literal `require` at the call site so esbuild can
	 * see which builtin to mark external, so the ban on require-style imports is lifted here and
	 * nowhere else. An architecture test asserts no static `import … from "node:…"` survives.
	 */
	{
		files: [
			"src/reader/external-file.ts",
			"src/sources/books/db.ts",
			"src/sources/sqlite.ts",
			"src/sources/zotero/db.ts",
			"src/sources/zotero/lookup.ts",
		],
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			// The rule matches on the module name, so it reports a guarded `require` exactly as it
			// reported the static import it replaced. The guard is the thing it was asking for.
			"obsidianmd/no-nodejs-modules": "off",
		},
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
	 * room — and `createEl`/`createDiv` are Obsidian's augmentations, which such a document does
	 * not have. Using them here would couple pure DOM code to the app and break its tests to
	 * satisfy a style rule.
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
			// A test for the guarded-`require` pattern has to be able to write one.
			"@typescript-eslint/no-require-imports": "off",
			// A spy references a method without calling it; that is what a spy is.
			"@typescript-eslint/unbound-method": "off",
		},
	},
);
