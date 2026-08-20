/**
 * Reaching Node's own modules from a plugin that also runs on mobile.
 *
 * Three constraints meet here, and only one arrangement satisfies all of them.
 *
 * Mobile has no Node, so nothing may import a builtin at the top of a module the mobile app
 * loads. A *dynamic* `await import("node:fs")` is not the answer: esbuild leaves it as a real
 * ESM import, the renderer fetches it as a URL, and Obsidian's `app://obsidian.md` origin turns
 * that into a CORS failure — that happened in a real window. And a static import is what the
 * community review flags, because it cannot see that the module holding it is itself only ever
 * loaded on desktop.
 *
 * `require()` behind a `Platform.isDesktopApp` check is the arrangement that works, and it is
 * what the review asks for. It is resolved synchronously by Electron, it is never evaluated on
 * a platform that lacks it, and the guard turns a mistaken import into a sentence rather than a
 * stack trace about `fs` being undefined.
 *
 * Callers destructure at module scope, so the shape of the code that uses these is unchanged:
 *
 * ```ts
 * const { readFile } = onDesktop("node:fs/promises", () => require("node:fs/promises") as typeof import("node:fs/promises"));
 * ```
 */

import { Platform } from "obsidian";

/**
 * Load something that only exists on the desktop.
 *
 * The loader is a callback rather than a module name so the `require` stays a literal at the
 * call site — esbuild can only mark a builtin external when it can see which one it is.
 */
export function onDesktop<T>(id: string, load: () => T): T {
	if (!Platform.isDesktopApp) {
		throw new Error(
			`${id} is part of Node, which the mobile app does not have. This feature is desktop only.`,
		);
	}

	return load();
}
