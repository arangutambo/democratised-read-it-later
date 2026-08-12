import { Notice, Plugin } from "obsidian";

import { Disposables } from "./core/disposables";
import { Logger } from "./core/log";
import { migrateSettings } from "./settings/migrate";
import { ReaderSettingTab } from "./settings/tab";
import { DEFAULT_SETTINGS, type ReaderSettings } from "./settings/types";

export default class ReaderPlugin extends Plugin {
	// `Plugin` declares `settings?: unknown` as of the 1.13 typings; narrow it to ours.
	override settings: ReaderSettings = structuredClone(DEFAULT_SETTINGS);

	/**
	 * Every listener, observer, interval and iframe this plugin creates registers here, and
	 * `onunload()` drains it. Nothing is torn down by remembering to — see core/disposables.
	 */
	readonly disposables = new Disposables();

	readonly log = new Logger("[reader]");

	private settingTab?: ReaderSettingTab;

	override async onload(): Promise<void> {
		try {
			await this.loadSettings();
		} catch (error) {
			// A broken data.json must not stop the plugin loading — the settings tab is the
			// only way the user could fix it, and it needs the plugin to be running.
			this.log.error("failed to load settings; falling back to defaults", error);
			this.settings = structuredClone(DEFAULT_SETTINGS);
			new Notice("Reader: settings could not be read. Defaults are in use — check the console.");
		}

		this.settingTab = new ReaderSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.log.info(`loaded v${this.manifest.version}`);
	}

	override onunload(): void {
		const errors = this.disposables.dispose();
		for (const { name, error } of errors) {
			this.log.error(`teardown failed for "${name}":`, error);
		}
		this.log.info("unloaded");
	}

	/**
	 * @param writeBack persist repairs made during load. Suppressed when reacting to an
	 * external change, so two synced devices cannot ping-pong writes at each other.
	 */
	async loadSettings(writeBack = true): Promise<void> {
		const { settings, changed, notes } = migrateSettings(await this.loadData());
		this.settings = settings;
		this.log.setLevel(settings.logLevel);

		for (const note of notes) this.log.warn(note);
		if (notes.length > 0) {
			new Notice(`Reader: settings were repaired on load.\n${notes.join("\n")}`, 10_000);
		}

		if (changed && writeBack) await this.saveData(this.settings);
	}

	async saveSettings(): Promise<void> {
		this.log.setLevel(this.settings.logLevel);
		await this.saveData(this.settings);
	}

	/** Fired when data.json is rewritten underneath us — typically Obsidian Sync. */
	override async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings(false);
		if (this.settingTab?.containerEl.isConnected) this.settingTab.display();
		this.log.info("settings reloaded after external change");
	}
}
