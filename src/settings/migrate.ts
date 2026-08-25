/**
 * Settings loading, validation and schema migration.
 *
 * Exists from day one rather than being retrofitted, because settings live in a synced
 * `data.json` and this plugin is explicitly multi-device. Two consequences shape the code:
 *
 *  - A newer version on another device may have written fields this build has never heard
 *    of. Unrecognised top-level keys are carried through untouched rather than dropped, so
 *    syncing an old build over a new one degrades instead of destroying.
 *  - Anything on disk may be corrupt or hand-edited. Every field is coerced and validated;
 *    a bad value falls back to its default and is reported, never thrown.
 *
 * No `obsidian` import — unit-testable in plain Node.
 */

import { LOG_LEVELS, type LogLevel } from "../core/log";
import {
	DEFAULT_SETTINGS,
	SETTINGS_SCHEMA_VERSION,
	type FeatureFlags,
	type HighlightColour,
	type ReaderSettings,
} from "./types";

export type RawSettings = Record<string, unknown>;

/** Transforms data written by schema version N into schema version N+1. */
export type Migration = (data: RawSettings) => RawSettings;

/**
 * Schema 1 → 2. The v2 pivot: bulk PDF extraction was removed and replaced by the Reader
 * view, so the flags that gated it no longer describe anything that exists.
 *
 * `slidesImport` carries over to `reader` rather than defaulting: someone who had slide
 * import switched on wanted PDFs in their vault, and the Reader view is what now serves
 * that. Someone who had switched it off is not opted back in.
 */
const migrateV1toV2: Migration = (data) => {
	const features = isPlainObject(data.features) ? { ...data.features } : {};
	const hadSlides = typeof features.slidesImport === "boolean" ? features.slidesImport : true;

	features.reader = typeof features.reader === "boolean" ? features.reader : hadSlides;
	delete features.slidesImport;
	delete features.pdfImport;

	const next: RawSettings = { ...data, features };
	// The bulk inbox import is gone; the path it pointed at has nothing to configure.
	delete next.deckInboxPath;
	return next;
};

/** Keyed by the version being migrated *from*. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
	1: migrateV1toV2,
};

export interface MigrationResult {
	settings: ReaderSettings;
	/** True when the coerced result differs from disk, i.e. it is worth writing back. */
	changed: boolean;
	/** Human-readable account of anything repaired, dropped or migrated. */
	notes: string[];
}

function isPlainObject(value: unknown): value is RawSettings {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function asLogLevel(value: unknown, fallback: LogLevel): LogLevel {
	return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : fallback;
}

function coerceFeatures(value: unknown, notes: string[]): FeatureFlags {
	const source = isPlainObject(value) ? value : {};
	if (value !== undefined && !isPlainObject(value)) {
		notes.push("`features` was not an object; reset to defaults.");
	}
	const out = {} as FeatureFlags;
	for (const key of Object.keys(DEFAULT_SETTINGS.features) as (keyof FeatureFlags)[]) {
		out[key] = asBoolean(source[key], DEFAULT_SETTINGS.features[key]);
	}
	return out;
}

function coerceColours(value: unknown, notes: string[]): HighlightColour[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		notes.push("`highlightColours` was not an array; reset to empty.");
		return [];
	}

	const out: HighlightColour[] = [];
	const seen = new Set<string>();
	let dropped = 0;

	for (const entry of value) {
		if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id === "") {
			dropped++;
			continue;
		}
		if (seen.has(entry.id)) {
			dropped++;
			continue;
		}
		seen.add(entry.id);
		out.push({
			id: entry.id,
			name: asString(entry.name, entry.id),
			css: asString(entry.css, ""),
			sourceKeys: Array.isArray(entry.sourceKeys)
				? entry.sourceKeys.filter((k): k is string => typeof k === "string")
				: [],
		});
	}

	if (dropped > 0) {
		notes.push(`Dropped ${dropped} highlight colour(s) with a missing or duplicate id.`);
	}
	return out;
}

export function migrateSettings(
	raw: unknown,
	migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
	/** Injectable so migration behaviour can be tested at schema versions not yet released. */
	targetVersion: number = SETTINGS_SCHEMA_VERSION,
): MigrationResult {
	const notes: string[] = [];

	if (raw === null || raw === undefined) {
		return { settings: structuredClone(DEFAULT_SETTINGS), changed: true, notes };
	}

	if (!isPlainObject(raw)) {
		notes.push("Settings file was not an object; reset to defaults.");
		return { settings: structuredClone(DEFAULT_SETTINGS), changed: true, notes };
	}

	let data: RawSettings = { ...raw };

	let version =
		typeof data.schemaVersion === "number" && Number.isFinite(data.schemaVersion)
			? data.schemaVersion
			: 0;

	if (version > targetVersion) {
		notes.push(
			`Settings were written by a newer version (schema ${version} > ${targetVersion}). ` +
				`Unrecognised fields are preserved untouched.`,
		);
	}

	while (version < targetVersion) {
		const migration = migrations[version];
		if (!migration) {
			// Version 0 means the data predates `schemaVersion` or was hand-edited. Field
			// coercion below handles that completely, so it is not worth reporting — warning
			// on it would put a Notice in front of the user every time they edit data.json.
			if (version > 0) {
				notes.push(`No migration from schema ${version}; unknown fields fall back to defaults.`);
			}
			break;
		}
		data = migration(data);
		version++;
		notes.push(`Migrated settings to schema ${version}.`);
	}

	// Anything this build does not recognise rides along untouched, so an older build
	// syncing over a newer one degrades rather than destroying the newer build's data.
	const known = new Set(Object.keys(DEFAULT_SETTINGS));
	const preserved: RawSettings = {};
	for (const key of Object.keys(data)) {
		if (!known.has(key)) preserved[key] = data[key];
	}

	const settings: ReaderSettings = {
		schemaVersion: Math.max(version, targetVersion),
		features: coerceFeatures(data.features, notes),
		sourcesFolder: asString(data.sourcesFolder, DEFAULT_SETTINGS.sourcesFolder),
		assetsFolder: asString(data.assetsFolder, DEFAULT_SETTINGS.assetsFolder),
		decksFolder: asString(data.decksFolder, DEFAULT_SETTINGS.decksFolder),
		// 72 is a screen-resolution page and 600 is a 30 MB clip; both ends are user error.
		clipDpi: Math.round(asNumberInRange(data.clipDpi, DEFAULT_SETTINGS.clipDpi, 72, 600)),
		// 0% is a clip with nowhere to work; 400% is four pages of blank per clip.
		excalidrawWorkingRoom: Math.round(
			asNumberInRange(data.excalidrawWorkingRoom, DEFAULT_SETTINGS.excalidrawWorkingRoom, 0, 400),
		),
		zoteroDataDir: asString(data.zoteroDataDir, DEFAULT_SETTINGS.zoteroDataDir),
		anthropicApiKey: asString(data.anthropicApiKey, DEFAULT_SETTINGS.anthropicApiKey),
		libraryPath: asString(data.libraryPath, DEFAULT_SETTINGS.libraryPath),
		progressFile: asString(data.progressFile, DEFAULT_SETTINGS.progressFile),
		highlightColours: coerceColours(data.highlightColours, notes),
		importConfidenceThreshold: asNumberInRange(
			data.importConfidenceThreshold,
			DEFAULT_SETTINGS.importConfidenceThreshold,
			0,
			1,
		),
		deleteEverything: asBoolean(data.deleteEverything, DEFAULT_SETTINGS.deleteEverything),
		logLevel: asLogLevel(data.logLevel, DEFAULT_SETTINGS.logLevel),
	};

	const merged = { ...preserved, ...settings };
	const changed = JSON.stringify(raw) !== JSON.stringify(merged);

	return { settings: merged, changed, notes };
}
