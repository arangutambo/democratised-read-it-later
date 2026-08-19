import { beforeEach, describe, expect, it, vi } from "vitest";

// Types come from the real `obsidian` package so `src/` stays checked against the true API;
// these imports are type-only and erased at runtime. Values come from the stub, which is
// what vitest's alias substitutes for `obsidian` when main.ts imports it.
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { App, notices, type Plugin as StubPlugin } from "./stubs/obsidian";

import ReaderPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings/types";

const MANIFEST: PluginManifest = {
	id: "reader",
	name: "Reader",
	version: "0.1.0",
	minAppVersion: "1.9.0",
	author: "Antoine Haddad",
	description: "test",
};

function makePlugin(stored: unknown = null) {
	const plugin = new ReaderPlugin(new App() as unknown as ObsidianApp, MANIFEST);
	const saved: unknown[] = [];
	plugin.loadData = async () => stored;
	plugin.saveData = async (data: unknown) => {
		saved.push(structuredClone(data));
	};
	/** The same object, viewed through the stub's surface for assertions. */
	const stub = plugin as unknown as StubPlugin;
	return { plugin, stub, saved };
}

beforeEach(() => {
	notices.length = 0;
});

describe("ReaderPlugin lifecycle", () => {
	it("loads defaults on a first run and registers a settings tab", async () => {
		const { plugin, stub, saved } = makePlugin(null);

		await plugin.onload();

		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(stub.settingTabs).toHaveLength(1);
		// First run persists the defaults so data.json exists from the start.
		expect(saved).toHaveLength(1);
	});

	it("leaves nothing registered after unload", async () => {
		// The M1 exit criterion, and the guard against this vault's runaway-JS history.
		const { plugin } = makePlugin();
		await plugin.onload();

		const torn: string[] = [];
		plugin.disposables.add("interval", () => torn.push("interval"));
		plugin.disposables.add("observer", () => torn.push("observer"));
		expect(plugin.disposables.size).toBe(2);

		plugin.onunload();

		expect(plugin.disposables.size).toBe(0);
		expect(plugin.disposables.disposed).toBe(true);
		expect(torn).toEqual(["observer", "interval"]);
	});

	it("still loads when data.json is unreadable, and says so", async () => {
		const { plugin, stub } = makePlugin();
		plugin.loadData = async () => {
			throw new Error("EACCES");
		};

		await plugin.onload();

		// A broken settings file must not stop the plugin — the settings tab is the only
		// way to fix it, and it needs the plugin running.
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(stub.settingTabs).toHaveLength(1);
		expect(notices.join(" ")).toMatch(/settings could not be read/i);
	});

	it("repairs corrupt settings loudly rather than silently", async () => {
		const { plugin } = makePlugin({ logLevel: "chatty", importConfidenceThreshold: 99 });

		await plugin.onload();

		expect(plugin.settings.logLevel).toBe(DEFAULT_SETTINGS.logLevel);
		expect(plugin.settings.importConfidenceThreshold).toBe(1);
	});

	it("does not write back when settings change externally", async () => {
		// Two synced devices must not ping-pong writes at each other via data.json.
		const { plugin, saved } = makePlugin(structuredClone(DEFAULT_SETTINGS));
		await plugin.onload();
		expect(saved).toHaveLength(0);

		plugin.loadData = async () => ({ ...DEFAULT_SETTINGS, sourcesFolder: "FromOtherDevice" });
		await plugin.onExternalSettingsChange();

		expect(plugin.settings.sourcesFolder).toBe("FromOtherDevice");
		expect(saved).toHaveLength(0);
	});

	it("refreshes the settings tab on external change only when it is open", async () => {
		const { plugin, stub } = makePlugin(structuredClone(DEFAULT_SETTINGS));
		await plugin.onload();

		const tab = stub.settingTabs[0];
		const update = vi.spyOn(tab, "update").mockImplementation(() => {});

		await plugin.onExternalSettingsChange();
		expect(update).not.toHaveBeenCalled();

		(tab.containerEl as unknown as { isConnected: boolean }).isConnected = true;
		await plugin.onExternalSettingsChange();
		expect(update).toHaveBeenCalledOnce();
	});

	it("persists settings through saveSettings", async () => {
		const { plugin, saved } = makePlugin(structuredClone(DEFAULT_SETTINGS));
		await plugin.onload();

		plugin.settings.sourcesFolder = "Reading";
		plugin.settings.logLevel = "debug";
		await plugin.saveSettings();

		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ sourcesFolder: "Reading", logLevel: "debug" });
	});
});

describe("Reader view registration", () => {
	it("registers the view and claims the .reader extension", async () => {
		const { plugin, stub } = makePlugin(null);
		await plugin.onload();

		expect(stub.views.has("reader-document")).toBe(true);
		expect(stub.extensions.get("reader")).toBe("reader-document");
	});

	it("never claims .pdf, which core already owns", async () => {
		/*
		 * ViewRegistry.registerExtensions throws outright for an extension that is taken:
		 *
		 *   if (n.hasOwnProperty(o)) throw new Error('Attempting to register an existing …')
		 *
		 * Releasing `pdf` first needs app.viewRegistry.unregisterExtensions, which is not in
		 * the public typings. Writing our own renderer to avoid internals and then using
		 * internals to launch it would be a poor trade, so the entry point is a menu item and
		 * the .reader file it leaves behind.
		 */
		const { plugin, stub } = makePlugin(null);
		await plugin.onload();

		expect(stub.extensions.has("pdf")).toBe(false);
	});

	it("offers Open in Reader as a command", async () => {
		const { plugin, stub } = makePlugin(null);
		await plugin.onload();

		expect(stub.commands.map((c) => c.id)).toContain("open-in-reader");
	});

	it("registers nothing when the reader feature is switched off", async () => {
		const { plugin, stub } = makePlugin({
			schemaVersion: 2,
			features: { reader: false },
		});
		await plugin.onload();

		expect(stub.views.size).toBe(0);
		expect(stub.extensions.size).toBe(0);
	});
});
