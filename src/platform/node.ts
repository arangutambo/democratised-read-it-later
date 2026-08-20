/**
 * The guard in front of the modules that need Node.
 *
 * Obsidian's own review asks for Node builtins to be reached through a `require()` or dynamic
 * `import()` behind a `Platform.isDesktopApp` check. Both were tried, and neither is available:
 *
 * - A dynamic `await import("node:fs")` survives esbuild as a real ESM import, which the
 *   renderer fetches as a URL and Obsidian's `app://obsidian.md` origin refuses. Verified by
 *   compiling it and reading the output; it also reached a real window once.
 * - A guarded `require()` works perfectly, and the reviewer's *other* rule forbids `require()`
 *   outright — so that form is reported twice rather than once.
 *
 * The rule fires on the name of the module, not on how it is reached, so no arrangement of
 * imports satisfies it. What is left is to make the safety property real rather than implied: a
 * module that needs Node says so, out loud, the moment it is loaded.
 *
 * That is what this is. Modules touching a builtin call `assertDesktop()` at module scope, and
 * because they are only ever reached through a lazy `import("./that-module")` behind a
 * `Platform.isDesktopApp` check, the assertion never fires in normal use. When it does, it means
 * a caller lost its guard — and it says that, instead of failing later as `undefined is not a
 * function`.
 */

import { Platform } from "obsidian";

/**
 * Refuse to be loaded anywhere without Node.
 *
 * Called for its side effect at the top of a module, so the failure lands at the import rather
 * than at the first call into it.
 */
export function assertDesktop(module: string): void {
	if (!Platform.isDesktopApp) {
		throw new Error(
			`${module} needs Node, which the mobile app does not have. This feature is desktop only.`,
		);
	}
}
