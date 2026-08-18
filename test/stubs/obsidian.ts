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
		getLeavesOfType: (): unknown[] => [],
		getLeaf: (): { openFile: (file: unknown) => Promise<void> } => ({
			openFile: async () => {},
		}),
		/** Returns an EventRef in the real API; the plugin only ever passes it to registerEvent. */
		on: (name: string, callback: unknown): unknown => ({ name, callback }),
		off: (): void => {},
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

/**
 * `View` → `FileView` → `EditableFileView` → `TextFileView`, flattened to the members the
 * plugin actually touches. Checked against node_modules/obsidian/obsidian.d.ts rather than
 * recalled — `TextFileView` is where `data`, `requestSave()` and the get/setViewData contract
 * live, and ReaderView is built on all four.
 */
export class View {
	containerEl = { children: [null, null] } as unknown as HTMLElement;
	contentEl = {} as unknown as HTMLElement;

	constructor(public leaf: unknown) {}

	registerDomEvent(): void {}
	registerEvent(): void {}
	registerInterval(): number {
		return 0;
	}
	register(_cb: () => unknown): void {}
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}

/*
 * A pane that is not a file — the library.
 *
 * Absent for a while, and its absence was invisible: `library/view.ts` extends it, `main.ts`
 * imports that, and `main.test.ts` imports `main.ts`, so the whole lifecycle suite failed at
 * collection while the summary line still read all-green because no test inside it ran.
 */
export class ItemView extends View {
	getViewType(): string {
		return "";
	}
	getDisplayText(): string {
		return "";
	}
	getIcon(): string {
		return "";
	}
	addAction(): unknown {
		return {};
	}
}

export class FileView extends View {
	file: TFile | null = null;
}

export class EditableFileView extends FileView {}

export class TextFileView extends EditableFileView {
	data = "";
	requestSave: () => void = () => {};
}

export class TFile {}
export class TFolder {}

export function setIcon(_el: HTMLElement, _icon: string): void {}

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
	readonly views = new Map<string, unknown>();
	readonly extensions = new Map<string, string>();
	readonly events: unknown[] = [];
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

	registerView(type: string, creator: unknown): void {
		this.views.set(type, creator);
	}

	/**
	 * The real one **throws** for an extension that is already registered, which is why
	 * Reader claims `.reader` and not `.pdf` — core owns `pdf`. Modelled faithfully so a
	 * future attempt to claim a taken extension fails here rather than in a live window.
	 */
	registerExtensions(extensions: string[], viewType: string): void {
		for (const extension of extensions) {
			if (this.extensions.has(extension)) {
				throw new Error(`Attempting to register an existing file extension "${extension}"`);
			}
		}
		for (const extension of extensions) this.extensions.set(extension, viewType);
	}

	registerEvent(ref: unknown): unknown {
		this.events.push(ref);
		return ref;
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

/** Enough of `Modal` for the clip picker to be constructed and torn down in a test. */
/** The quick switcher's base. Fuzzy matching itself is Obsidian's, not ours to imitate. */
export class FuzzySuggestModal<T> {
	constructor(public app: unknown) {}
	setPlaceholder(_text: string): void {}
	setInstructions(_items: unknown[]): void {}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
	onChooseItem(_item: T, _event?: unknown): void {}
	open(): void {}
	close(): void {}
}

export class Modal {
	contentEl = {
		empty: (): void => {},
		createEl: (): unknown => ({}),
		createDiv: (): unknown => ({}),
	} as unknown as HTMLElement;

	constructor(public app: App) {}

	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}
