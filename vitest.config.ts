import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// Lets the plugin lifecycle be asserted without a running Obsidian.
			obsidian: path.resolve(__dirname, "test/stubs/obsidian.ts"),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		/*
		 * The real-deck suites parse a 2.5 MB PDF with pdf.js per test, which lands at 3–4.5
		 * seconds against the 5 s default — close enough that a loaded machine turns them red
		 * at random. A suite that fails on a coin flip trains you to ignore failures, which is
		 * the same way the extraction fixture managed to sit silently skipped for weeks.
		 */
		testTimeout: 30_000,
	},
});
