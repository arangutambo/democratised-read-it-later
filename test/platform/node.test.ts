/**
 * The desktop guard in front of Node's builtins.
 *
 * The point of `onDesktop` is not that it loads things — `require` does that. It is that a
 * module reaching for `node:fs` on a platform without Node fails with a sentence someone can
 * act on, at the moment of the mistake, rather than as `undefined is not a function` somewhere
 * downstream. So that is what is asserted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Platform } from "obsidian";
import { onDesktop } from "../../src/platform/node";

afterEach(() => {
	Platform.isDesktopApp = true;
});

describe("onDesktop", () => {
	it("hands back what the loader loaded, on the desktop", () => {
		const nodePath = onDesktop("node:path", () => require("node:path") as typeof import("node:path"));
		expect(nodePath.basename("/a/b/c.pdf")).toBe("c.pdf");
	});

	it("refuses on mobile, and says why in a sentence", () => {
		Platform.isDesktopApp = false;

		expect(() => onDesktop("node:fs", () => ({}))).toThrow(/node:fs/);
		expect(() => onDesktop("node:fs", () => ({}))).toThrow(/desktop only/i);
	});

	it("does not even run the loader on mobile", () => {
		Platform.isDesktopApp = false;
		const load = vi.fn(() => ({}));

		expect(() => onDesktop("node:fs", load)).toThrow();
		// The whole reason this is a callback: evaluating it is what breaks on a platform
		// without Node, so the guard has to come first.
		expect(load).not.toHaveBeenCalled();
	});
});
