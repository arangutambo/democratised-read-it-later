/**
 * Minimal stand-in for the `obsidian` module, aliased in vitest.config.ts.
 *
 * Only the surface `src/main.ts` and `src/settings/tab.ts` actually touch is modelled, and
 * every member here was checked against node_modules/obsidian/obsidian.d.ts rather than
 * recalled. This exists so the plugin lifecycle can be asserted without a running Obsidian.
 */

export class App {
	workspace = {
		getActiveViewOfType: (): unknown => null,
		getActiveFile: (): unknown => null,
		getLeaf: (): { openFile: (file: unknown) => Promise<void> } => ({
			openFile: async () => {},
		}),
	};

	vault = {
		getMarkdownFiles: (): unknown[] => [],
		getFileByPath: (): unknown => null,
		getAbstractFileByPath: (): unknown => null,
		create: async (): Promise<void> => {},
		createBinary: async (): Promise<void> => {},
		createFolder: async (): Promise<void> => {},
		readBinary: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
	};

	metadataCache = {
		getFileCache: (): unknown => null,
	};
}

/**
 * Obsidian loads pdf.js lazily. Returning nothing models a build where the load fails,
 * which is what the guard in extract.ts exists to report.
 */
export let pdfJsForTests: unknown = undefined;
export function setPdfJsForTests(lib: unknown): void {
	pdfJsForTests = lib;
}
export async function loadPdfJs(): Promise<unknown> {
	return pdfJsForTests;
}

export class MarkdownView {}
export class TFile {}
export class TFolder {}

export const Platform = { isDesktopApp: true, isMacOS: true, isMobile: false };

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

export class MarkdownRenderChild {
	constructor(public containerEl: HTMLElement) {}
	onunload(): void {}
}

export interface Command {
	id: string;
	name: string;
	checkCallback?: (checking: boolean) => boolean | void;
	callback?: () => unknown;
}

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
	readonly commands: Command[] = [];
	readonly postProcessors: unknown[] = [];
	private readonly registered: (() => unknown)[] = [];

	constructor(
		public app: App,
		public manifest: PluginManifest,
	) {}

	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
	}

	addCommand(command: Command): Command {
		this.commands.push(command);
		return command;
	}

	registerMarkdownPostProcessor(processor: unknown): unknown {
		this.postProcessors.push(processor);
		return processor;
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
