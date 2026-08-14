import { App, PluginSettingTab, Setting } from "obsidian";

import { LOG_LEVELS } from "../core/log";
import type ReaderPlugin from "../main";
import {
	FEATURE_LABELS,
	IMPLEMENTED_FEATURES,
	SUGGESTED_COLOURS,
	type FeatureKey,
} from "./types";

export class ReaderSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: ReaderPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderFolders(containerEl);
		this.renderLibrary(containerEl);
		this.renderColours(containerEl);
		this.renderImport(containerEl);
		this.renderFeatures(containerEl);
		this.renderAdvanced(containerEl);
	}

	private save(): void {
		void this.plugin.saveSettings();
	}

	private renderFolders(el: HTMLElement): void {
		new Setting(el).setName("Folders").setHeading();

		new Setting(el)
			.setName("Sources folder")
			.setDesc("Where imported source notes are written.")
			.addText((text) =>
				text
					.setPlaceholder("Sources")
					.setValue(this.plugin.settings.sourcesFolder)
					.onChange((value) => {
						this.plugin.settings.sourcesFolder = value.trim();
						this.save();
					}),
			);

		new Setting(el)
			.setName("Assets folder")
			.setDesc("Where cited images are written. Only images you actually reference land here.")
			.addText((text) =>
				text
					.setPlaceholder("Sources/_assets")
					.setValue(this.plugin.settings.assetsFolder)
					.onChange((value) => {
						this.plugin.settings.assetsFolder = value.trim();
						this.save();
					}),
			);

		new Setting(el)
			.setName("Slide decks folder")
			.setDesc(
				"Imported decks are copied here so their pages can be embedded in notes. " +
					"Obsidian can only render a PDF that lives inside the vault.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Sources/_decks")
					.setValue(this.plugin.settings.decksFolder)
					.onChange((value) => {
						this.plugin.settings.decksFolder = value.trim();
						this.save();
					}),
			);

		new Setting(el)
			.setName("Clip resolution")
			.setDesc(
				"Resolution for clipped regions and pages, in DPI. 150 keeps small type in dense " +
					"slides readable when you zoom, at roughly 80–250 KB a region. Lower saves space; " +
					"a clip you cannot read is not worth keeping.",
			)
			.addText((text) =>
				text
					.setPlaceholder("150")
					.setValue(String(this.plugin.settings.clipDpi))
					.onChange((value) => {
						const dpi = Number.parseInt(value, 10);
						if (!Number.isFinite(dpi)) return;
						this.plugin.settings.clipDpi = Math.min(600, Math.max(72, dpi));
						this.save();
					}),
			);

		new Setting(el)
			.setName("Zotero data directory")
			.setDesc(
				"Where Zotero keeps zotero.sqlite and its storage folder. Blank uses ~/Zotero. " +
					"Reader only ever reads from it.",
			)
			.addText((text) =>
				text
					.setPlaceholder("~/Zotero")
					.setValue(this.plugin.settings.zoteroDataDir)
					.onChange((value) => {
						this.plugin.settings.zoteroDataDir = value.trim();
						this.save();
					}),
			);

		new Setting(el)
			.setName("Progress file")
			.setDesc(
				"Reading progress is kept in this one file rather than in each note's frontmatter, " +
					"so scrolling never rewrites your notes or churns sync.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Sources/.reader-progress.json")
					.setValue(this.plugin.settings.progressFile)
					.onChange((value) => {
						this.plugin.settings.progressFile = value.trim();
						this.save();
					}),
			);
	}

	private renderLibrary(el: HTMLElement): void {
		new Setting(el).setName("Library").setHeading();

		const desc = document.createDocumentFragment();
		desc.append(
			"Absolute path to the folder holding originals — EPUBs, full PDFs, slide decks. ",
			"Kept outside the vault so binaries never bloat it. ",
		);
		desc.createEl("br");
		desc.append(
			"To read these inside Obsidian they must be reachable from the vault: symlink this " +
				"folder in, then exclude the symlink from Obsidian Sync.",
		);

		new Setting(el)
			.setName("Library path")
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder("/Users/you/Library")
					.setValue(this.plugin.settings.libraryPath)
					.onChange((value) => {
						this.plugin.settings.libraryPath = value.trim();
						this.save();
					}),
			);
	}

	private renderColours(el: HTMLElement): void {
		new Setting(el).setName("Highlight colours").setHeading();

		const colours = this.plugin.settings.highlightColours;

		if (colours.length === 0) {
			el.createEl("p", {
				cls: "reader-setting-note",
				text:
					"No colour meanings defined. Colours carry whatever meaning you give them — " +
					"nothing is imposed. Add your own, or start from a suggested set and edit it.",
			});
		}

		for (const colour of colours) {
			new Setting(el)
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
							this.display();
						}),
				);
		}

		new Setting(el)
			.addButton((button) =>
				button.setButtonText("Add colour").onClick(() => {
					this.plugin.settings.highlightColours.push({
						id: `colour-${Date.now().toString(36)}`,
						name: "",
						css: "",
						sourceKeys: [],
					});
					this.save();
					this.display();
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
						this.display();
					}),
			);
	}

	private renderImport(el: HTMLElement): void {
		new Setting(el).setName("Import").setHeading();

		new Setting(el)
			.setName("Confidence threshold")
			.setDesc(
				"Imports scoring below this are marked needs-review instead of being trusted. " +
					"Nothing is ever silently dropped.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.importConfidenceThreshold)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.importConfidenceThreshold = value;
						this.save();
					}),
			);
	}

	private renderFeatures(el: HTMLElement): void {
		new Setting(el).setName("Features").setHeading();

		el.createEl("p", {
			cls: "reader-setting-note",
			text:
				"Each subsystem can be switched off independently, so a misbehaving one never " +
				"requires uninstalling the plugin. Subsystems ship progressively; those not yet " +
				"built are marked.",
		});

		const flags = this.plugin.settings.features;
		for (const key of Object.keys(FEATURE_LABELS) as FeatureKey[]) {
			const label = FEATURE_LABELS[key];
			const built = IMPLEMENTED_FEATURES.has(key);

			new Setting(el)
				.setName(built ? label.name : `${label.name} (not yet built)`)
				.setDesc(label.description)
				.addToggle((toggle) =>
					toggle.setValue(flags[key]).onChange((value) => {
						flags[key] = value;
						this.save();
					}),
				);
		}
	}

	private renderAdvanced(el: HTMLElement): void {
		new Setting(el).setName("Advanced").setHeading();

		new Setting(el)
			.setName("Log level")
			.setDesc("How much this plugin writes to the developer console.")
			.addDropdown((dropdown) => {
				for (const level of LOG_LEVELS) dropdown.addOption(level, level);
				dropdown.setValue(this.plugin.settings.logLevel).onChange((value) => {
					this.plugin.settings.logLevel = value as (typeof LOG_LEVELS)[number];
					this.save();
				});
			});
	}
}
