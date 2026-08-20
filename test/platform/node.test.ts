/**
 * The guard in front of the modules that need Node.
 *
 * Its whole job is to turn "a module that needs Node was loaded without Node" into a sentence,
 * at the moment it happens, instead of an `undefined is not a function` somewhere downstream.
 */

import { afterEach, describe, expect, it } from "vitest";

import { Platform } from "obsidian";
import { assertDesktop } from "../../src/platform/node";

afterEach(() => {
	Platform.isDesktopApp = true;
});

describe("assertDesktop", () => {
	it("says nothing on the desktop, which is the normal case", () => {
		expect(() => assertDesktop("sqlite.ts")).not.toThrow();
	});

	it("names the module and the reason when there is no Node", () => {
		Platform.isDesktopApp = false;

		expect(() => assertDesktop("sqlite.ts")).toThrow(/sqlite\.ts/);
		expect(() => assertDesktop("sqlite.ts")).toThrow(/desktop only/i);
	});
});
