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
	},
});
