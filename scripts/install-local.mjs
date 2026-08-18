import { copyFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const PLUGIN_ID = "democratised-read-it-later";
const VAULT =
	process.env.OBSIDIAN_VAULT ??
	path.join(process.env.HOME, "Documents", "Obsidian Vault");

const dest = path.join(VAULT, ".obsidian", "plugins", PLUGIN_ID);

if (!existsSync(VAULT)) {
	console.error(`Vault not found: ${VAULT}\nSet OBSIDIAN_VAULT to override.`);
	process.exit(1);
}

await mkdir(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
	await copyFile(f, path.join(dest, f));
	console.log(`→ ${path.join(dest, f)}`);
}
console.log("\nInstalled. Reload Obsidian (Cmd+R) to pick up the new build.");
