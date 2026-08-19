/**
 * The settings tab, declared rather than drawn.
 *
 * Obsidian 1.13 replaced `display()` with `getSettingDefinitions()`, and the difference is not
 * cosmetic: a tab that only paints itself is invisible to the settings search, so a person
 * looking for "clip resolution" from the search box never finds it. Declaring the settings
 * means the app can find them, render them, and re-render them on its own terms.
 *
 * The two things that cannot be declared — the API key, which has to be a password field, and
 * the highlight colours, which are a list the user edits — use `render` items, which is what
 * that escape hatch is for.
 */

import {
	App,
	PluginSettingTab,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from "obsidian";

import { LOG_LEVELS } from "../core/log";
import type ReaderPlugin from "../main";
import {
	FEATURE_LABELS,
	IMPLEMENTED_FEATURES,
	SUGGESTED_COLOURS,
	type FeatureKey,
} from "./types";

/** Keys whose value is a path or a token, where surrounding spaces are always a mistake. */
const TRIMMED = new Set([
	"sourcesFolder",
	"assetsFolder",
	"decksFolder",
	"zoteroDataDir",
	"anthropicApiKey",
	"progressFile",
	"libraryPath",
]);

export class ReaderSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: ReaderPlugin,
	) {
		super(app, plugin);
	}

	private save(): void {
		void this.plugin.saveSettings();
	}

	/**
	 * Read a setting by key, including the nested feature flags.
	 *
	 * The default resolver reads a flat property off `plugin.settings`; the feature toggles live
	 * one level down, so `features.reader` has to be understood here.
	 */
	override getControlValue(key: string): unknown {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;

		if (key.startsWith("features.")) {
			return this.plugin.settings.features[key.slice("features.".length) as FeatureKey];
		}

		return settings[key];
	}

	override setControlValue(key: string, value: unknown): void {
		if (key.startsWith("features.")) {
			this.plugin.settings.features[key.slice("features.".length) as FeatureKey] = Boolean(value);
			this.save();
			return;
		}

		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		settings[key] = typeof value === "string" && TRIMMED.has(key) ? value.trim() : value;
		this.save();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.folders(),
			this.library(),
			this.colours(),
			this.importing(),
			this.features(),
			this.advanced(),
		];
	}

	private folders(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Folders",
			items: [
				{
					name: "Sources folder",
					desc: "Where imported source notes are written.",
					control: { type: "text", key: "sourcesFolder", placeholder: "Sources" },
				},
				{
					name: "Assets folder",
					desc: "Where cited images are written. Only images you actually reference land here.",
					control: { type: "text", key: "assetsFolder", placeholder: "Sources/_assets" },
				},
				{
					name: "Slide decks folder",
					desc:
						"Imported decks are copied here so their pages can be embedded in notes. " +
						"A PDF can only be rendered from inside the vault.",
					control: { type: "text", key: "decksFolder", placeholder: "Sources/_decks" },
				},
				{
					name: "Clip resolution",
					desc:
						"Resolution for clipped regions and pages, in DPI. 150 keeps small type in dense " +
						"slides readable when you zoom, at roughly 80–250 KB a region. Lower saves space; " +
						"a clip you cannot read is not worth keeping.",
					aliases: ["dpi", "quality"],
					// A number control rather than a text box that parses itself: the bounds are
					// the app's problem now, and 600 DPI of a full page is already a large image.
					control: { type: "number", key: "clipDpi", placeholder: "150", min: 72, max: 600, step: 1 },
				},
				{
					name: "Excalidraw working room",
					desc:
						"Blank space left under each clip sent to Excalidraw, as a percentage of the clip's " +
						"own height. Proportional because a whole exam page needs more room underneath " +
						"than a one-line definition. 0 leaves none.",
					control: {
						type: "slider",
						key: "excalidrawWorkingRoom",
						min: 0,
						max: 300,
						step: 10,
						displayFormat: (value) => `${value}%`,
					},
				},
				{
					name: "Zotero data directory",
					desc:
						"Where Zotero keeps zotero.sqlite and its storage folder. Blank uses ~/Zotero. " +
						"Reader only ever reads from it.",
					control: { type: "text", key: "zoteroDataDir", placeholder: "~/Zotero" },
				},
				this.apiKey(),
				{
					name: "Progress file",
					desc:
						"Reading progress is kept in this one file rather than in each note's frontmatter, " +
						"so scrolling never rewrites your notes or churns sync.",
					control: { type: "text", key: "progressFile", placeholder: "Sources/.reader-progress.json" },
				},
			],
		};
	}

	/**
	 * The API key, as a password field.
	 *
	 * Declared controls have no masked variant, and this is the one setting where that matters:
	 * a key readable over someone's shoulder is a key that has to be rotated.
	 */
	private apiKey(): SettingGroupItem {
		return {
			name: "Anthropic API key",
			desc:
				"Only used when you press x to transcribe a clipped region. " +
				"Stored in plain text in this vault's data.json — so it syncs wherever the vault " +
				"syncs, and lands in whatever backs the vault up. Leave blank to keep Reader offline.",
			aliases: ["anthropic", "claude", "ai", "transcription"],
			render: (setting) => {
				setting.addText((text) => {
					text.inputEl.type = "password";
					text.inputEl.autocomplete = "off";

					return text
						.setPlaceholder("sk-ant-…")
						.setValue(this.plugin.settings.anthropicApiKey)
						.onChange((value) => {
							this.plugin.settings.anthropicApiKey = value.trim();
							this.save();
						});
				});
			},
		};
	}

	private library(): SettingDefinitionItem {
		const desc = createFragment();
		desc.append(
			"Absolute path to the folder holding originals — EPUBs, full PDFs, slide decks. ",
			"Kept outside the vault so binaries never bloat it. ",
		);
		desc.createEl("br");
		desc.append(
			"To read these they must be reachable from the vault: symlink this folder in, then " +
				"exclude the symlink from sync.",
		);

		return {
			type: "group",
			heading: "Library",
			items: [
				{
					name: "Library path",
					desc,
					aliases: ["originals", "external", "symlink"],
					control: { type: "text", key: "libraryPath", placeholder: "/Users/you/Library" },
				},
			],
		};
	}

	/**
	 * The highlight colours, which are a list rather than a setting.
	 *
	 * Rebuilt from the current settings every time the definitions are asked for, so adding or
	 * removing one is a mutation plus `update()` rather than a hand-rolled redraw.
	 */
	private colours(): SettingDefinitionItem {
		const colours = this.plugin.settings.highlightColours;

		const rows: SettingGroupItem[] = colours.map((colour) => ({
			name: colour.name === "" ? "Untitled colour" : colour.name,
			searchable: false,
			render: (setting) => {
				setting
					.addText((text) =>
						text
							.setPlaceholder("Meaning")
							.setValue(colour.name)
							.onChange((value) => {
								colour.name = value;
								this.save();
							}),
					)
					.addText((text) =>
						text
							.setPlaceholder("#ffd60a or highlightr class")
							.setValue(colour.css)
							.onChange((value) => {
								colour.css = value.trim();
								this.save();
							}),
					)
					.addExtraButton((button) =>
						button
							.setIcon("trash-2")
							.setTooltip("Remove")
							.onClick(() => {
								this.plugin.settings.highlightColours = colours.filter((c) => c !== colour);
								this.save();
								this.update();
							}),
					);
			},
		}));

		if (colours.length === 0) {
			rows.push({
				name: "No colour meanings defined",
				desc:
					"Colours carry whatever meaning you give them — nothing is imposed. Add your own, " +
					"or start from a suggested set and edit it.",
				searchable: false,
				render: () => {
					// The description is the whole content; there is no control to add.
				},
			});
		}

		rows.push({
			name: "Add a colour",
			aliases: ["highlight", "colour", "color"],
			render: (setting) => {
				setting
					.addButton((button) =>
						button.setButtonText("Add colour").onClick(() => {
							this.plugin.settings.highlightColours.push({
								id: `colour-${Date.now().toString(36)}`,
								name: "",
								css: "",
								sourceKeys: [],
							});
							this.save();
							this.update();
						}),
					)
					.addButton((button) =>
						button
							.setButtonText("Use suggested set")
							.setDisabled(colours.length > 0)
							.setTooltip(
								colours.length > 0
									? "Remove your existing colours first"
									: "Adds five starting colours mapped to Apple Books' styles. Edit or delete freely.",
							)
							.onClick(() => {
								this.plugin.settings.highlightColours = structuredClone(
									SUGGESTED_COLOURS,
								) as typeof this.plugin.settings.highlightColours;
								this.save();
								this.update();
							}),
					);
			},
		});

		return { type: "group", heading: "Highlight colours", items: rows };
	}

	private importing(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Import",
			items: [
				{
					name: "Confidence threshold",
					desc:
						"Imports scoring below this are marked needs-review instead of being trusted. " +
						"Nothing is ever silently dropped.",
					control: {
						type: "slider",
						key: "importConfidenceThreshold",
						min: 0,
						max: 1,
						step: 0.05,
						displayFormat: (value) => value.toFixed(2),
					},
				},
			],
		};
	}

	private features(): SettingDefinitionItem {
		const items: SettingGroupItem[] = (Object.keys(FEATURE_LABELS) as FeatureKey[]).map((key) => {
			const label = FEATURE_LABELS[key];
			const built = IMPLEMENTED_FEATURES.has(key);

			return {
				name: built ? label.name : `${label.name} (not yet built)`,
				desc: label.description,
				control: { type: "toggle", key: `features.${key}` },
			};
		});

		return { type: "group", heading: "Features", items };
	}

	private advanced(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Advanced",
			items: [
				{
					name: "Log level",
					desc: "How much this plugin writes to the developer console.",
					control: {
						type: "dropdown",
						key: "logLevel",
						options: Object.fromEntries(LOG_LEVELS.map((level) => [level, level])),
					},
				},
			],
		};
	}
}
