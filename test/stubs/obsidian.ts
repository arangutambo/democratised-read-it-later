/**
 * Minimal stand-in for the `obsidian` module, aliased in vitest.config.ts.
 *
 * Only the surface `src/main.ts` and `src/settings/tab.ts` actually touch is modelled, and
 * every member here was checked against node_modules/obsidian/obsidian.d.ts rather than
 * recalled. This exists so the plugin lifecycle can be asserted without a running Obsidian.
 */

export class App {}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	author: string;
	description: string;
}

export const notices: string[] = [];

export class Notice {
	constructor(message: string, _duration?: number) {
		notices.push(message);
	}
}

export class Plugin {
	settings?: unknown;
	readonly settingTabs: PluginSettingTab[] = [];
	private readonly registered: (() => unknown)[] = [];

	constructor(
		public app: App,
		public manifest: PluginManifest,
	) {}

	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
	}

	register(cb: () => unknown): void {
		this.registered.push(cb);
	}

	async loadData(): Promise<unknown> {
		return null;
	}

	async saveData(_data: unknown): Promise<void> {}
}

export class PluginSettingTab {
	containerEl = { isConnected: false } as unknown as HTMLElement;

	constructor(
		public app: App,
		public plugin: Plugin,
	) {}

	display(): void {}
}

/** Chainable no-op matching the real builder, so tab code can be constructed safely. */
export class Setting {
	constructor(_containerEl: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addSlider(): this {
		return this;
	}
	addDropdown(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
	addExtraButton(): this {
		return this;
	}
}
