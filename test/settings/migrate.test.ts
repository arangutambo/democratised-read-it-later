import { describe, expect, it } from "vitest";

import { migrateSettings, type Migration, type RawSettings } from "../../src/settings/migrate";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from "../../src/settings/types";

describe("migrateSettings", () => {
	describe("absent or unusable data", () => {
		it("returns defaults for a first run", () => {
			const { settings, changed } = migrateSettings(null);
			expect(settings).toEqual(DEFAULT_SETTINGS);
			expect(changed).toBe(true);
		});

		it("returns defaults for undefined", () => {
			expect(migrateSettings(undefined).settings).toEqual(DEFAULT_SETTINGS);
		});

		it.each([["a string"], [42], [[1, 2, 3]]])("resets non-object data: %s", (raw) => {
			const { settings, notes } = migrateSettings(raw);
			expect(settings).toEqual(DEFAULT_SETTINGS);
			expect(notes.join(" ")).toMatch(/not an object/i);
		});

		it("does not share mutable state with DEFAULT_SETTINGS", () => {
			const { settings } = migrateSettings(null);
			settings.features.readerSkin = !settings.features.readerSkin;
			settings.highlightColours.push({ id: "x", name: "x", css: "", sourceKeys: [] });

			expect(DEFAULT_SETTINGS.features.readerSkin).toBe(true);
			expect(DEFAULT_SETTINGS.highlightColours).toHaveLength(0);
		});
	});

	describe("field coercion", () => {
		it("fills missing fields from defaults and reports no change when already valid", () => {
			const { settings, changed } = migrateSettings(structuredClone(DEFAULT_SETTINGS));
			expect(settings).toEqual(DEFAULT_SETTINGS);
			expect(changed).toBe(false);
		});

		it("replaces wrongly typed scalars with their defaults", () => {
			const { settings } = migrateSettings({
				schemaVersion: SETTINGS_SCHEMA_VERSION,
				sourcesFolder: 17,
				libraryPath: null,
				logLevel: "chatty",
			});

			expect(settings.sourcesFolder).toBe(DEFAULT_SETTINGS.sourcesFolder);
			expect(settings.libraryPath).toBe(DEFAULT_SETTINGS.libraryPath);
			expect(settings.logLevel).toBe(DEFAULT_SETTINGS.logLevel);
		});

		it("clamps the confidence threshold into 0..1", () => {
			expect(migrateSettings({ importConfidenceThreshold: 5 }).settings.importConfidenceThreshold).toBe(1);
			expect(migrateSettings({ importConfidenceThreshold: -2 }).settings.importConfidenceThreshold).toBe(0);
			expect(migrateSettings({ importConfidenceThreshold: NaN }).settings.importConfidenceThreshold).toBe(
				DEFAULT_SETTINGS.importConfidenceThreshold,
			);
		});

		it("keeps known feature flags and ignores unknown ones", () => {
			const { settings } = migrateSettings({
				features: { readerSkin: true, booksImport: "yes", notARealFeature: true },
			});

			expect(settings.features.readerSkin).toBe(true);
			// A wrongly typed flag falls back to its own default, whatever that currently is.
			expect(settings.features.booksImport).toBe(DEFAULT_SETTINGS.features.booksImport);
			expect(settings.features).not.toHaveProperty("notARealFeature");
		});

		it("resets a non-object features block", () => {
			const { settings, notes } = migrateSettings({ features: "all" });
			expect(settings.features).toEqual(DEFAULT_SETTINGS.features);
			expect(notes.join(" ")).toMatch(/features/i);
		});
	});

	describe("highlight colours", () => {
		it("keeps valid entries and defaults their optional fields", () => {
			const { settings } = migrateSettings({
				highlightColours: [{ id: "key-claim", name: "Key claim", css: "#ffd60a", sourceKeys: ["books:3"] }, { id: "bare" }],
			});

			expect(settings.highlightColours).toEqual([
				{ id: "key-claim", name: "Key claim", css: "#ffd60a", sourceKeys: ["books:3"] },
				{ id: "bare", name: "bare", css: "", sourceKeys: [] },
			]);
		});

		it("drops entries with a missing or duplicate id, and says so", () => {
			const { settings, notes } = migrateSettings({
				highlightColours: [{ id: "a" }, { id: "a" }, { name: "no id" }, "nonsense"],
			});

			expect(settings.highlightColours.map((c) => c.id)).toEqual(["a"]);
			expect(notes.join(" ")).toMatch(/dropped 3/i);
		});

		it("discards non-string sourceKeys", () => {
			const { settings } = migrateSettings({
				highlightColours: [{ id: "a", sourceKeys: ["books:3", 5, null] }],
			});
			expect(settings.highlightColours[0].sourceKeys).toEqual(["books:3"]);
		});
	});

	describe("schema versioning", () => {
		it("applies migrations in sequence up to the current version", () => {
			const applied: number[] = [];
			const migrations: Record<number, Migration> = {
				0: (data: RawSettings) => {
					applied.push(0);
					return { ...data, sourcesFolder: "FromV0" };
				},
				1: (data: RawSettings) => {
					applied.push(1);
					return { ...data, sourcesFolder: "FromV1" };
				},
			};

			const { settings, notes } = migrateSettings({ schemaVersion: 0 }, migrations);

			// Runs only the migrations needed to reach SETTINGS_SCHEMA_VERSION, no further.
			expect(applied).toEqual(Array.from({ length: SETTINGS_SCHEMA_VERSION }, (_, i) => i));
			expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
			expect(notes.filter((n) => /migrated/i.test(n))).toHaveLength(SETTINGS_SCHEMA_VERSION);
		});

		it("coerces unversioned data quietly", () => {
			// Data predating `schemaVersion`, or hand-edited. Coercion handles it, so this
			// must not produce a note — notes reach the user as a Notice popup.
			const { settings, notes } = migrateSettings({ sourcesFolder: "Kept" }, {});

			expect(notes).toEqual([]);
			expect(settings.sourcesFolder).toBe("Kept");
			expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
		});

		it("reports a genuinely missing migration between released versions", () => {
			const { notes } = migrateSettings({ schemaVersion: 1 }, {}, 4);
			expect(notes.join(" ")).toMatch(/no migration from schema 1/i);
		});

		it("preserves fields written by a newer version instead of destroying them", () => {
			// Two devices, one ahead of the other, sharing data.json via Obsidian Sync.
			const fromNewerBuild = {
				schemaVersion: SETTINGS_SCHEMA_VERSION + 3,
				sourcesFolder: "Sources",
				somethingFromTheFuture: { nested: true },
			};

			const { settings, notes } = migrateSettings(fromNewerBuild);

			expect(settings).toHaveProperty("somethingFromTheFuture", { nested: true });
			expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION + 3);
			expect(notes.join(" ")).toMatch(/newer version/i);
		});
	});
});
