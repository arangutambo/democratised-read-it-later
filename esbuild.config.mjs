import esbuild from "esbuild";
import process from "process";
import path from "path";
import { existsSync } from "fs";
import { copyFile, mkdir, writeFile } from "fs/promises";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const PLUGIN_ID = "reader";
const VAULT =
	process.env.OBSIDIAN_VAULT ??
	path.join(process.env.HOME, "Documents", "🧠 Second Brain");

const vaultPluginDir = path.join(VAULT, ".obsidian", "plugins", PLUGIN_ID);

/*
 * Dev builds land directly in the vault so Hot Reload picks them up on save; production
 * builds stay in the repo for release packaging. Hot Reload watches main.js and styles.css
 * in any plugin directory containing a `.git` subdirectory or a `.hotreload` file, so the
 * dev build writes that marker itself — no manual setup, and it never ships in a release.
 */
let outDir = ".";

if (!prod) {
	if (!existsSync(VAULT)) {
		console.error(
			`Vault not found: ${VAULT}\n` +
				`Set OBSIDIAN_VAULT to override, or run \`npm run build\` for a repo-local build.`,
		);
		process.exit(1);
	}
	await mkdir(vaultPluginDir, { recursive: true });
	outDir = vaultPluginDir;
	await writeFile(path.join(outDir, ".hotreload"), "");
	console.log(`dev build → ${outDir}`);
}

/** Keeps manifest.json beside the build so Obsidian sees version changes without a restart. */
const copyManifest = {
	name: "copy-manifest",
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) return;
			if (outDir === ".") return;
			await copyFile("manifest.json", path.join(outDir, "manifest.json"));
		});
	},
};

const shared = {
	bundle: true,
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
};

const js = await esbuild.context({
	...shared,
	entryPoints: ["src/main.ts"],
	external: ["obsidian", "electron", ...builtins],
	outfile: path.join(outDir, "main.js"),
	plugins: [copyManifest],
});

const css = await esbuild.context({
	...shared,
	entryPoints: ["src/styles/index.css"],
	outfile: path.join(outDir, "styles.css"),
	format: undefined,
});

if (prod) {
	await js.rebuild();
	await css.rebuild();
	await js.dispose();
	await css.dispose();
	process.exit(0);
} else {
	await js.watch();
	await css.watch();
}
