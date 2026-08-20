/**
 * Turning a URL into a document you own.
 *
 * The page is fetched, cleaned, and written to disk — after which it is a local file like any
 * other in the vault: readable offline, greppable, and clipped with the same keys. Nothing
 * about it depends on the site still being there next year, which is the entire point of a
 * read-it-later that lives in your own files.
 */

import { Modal, Notice, Setting, TFile, type App } from "obsidian";

import { sanitiseArticle } from "./sanitise";
import { parseArticle } from "./article";
import { fetchPage, fileNameFor, SaveUrlError, titleOf } from "./fetch";

export interface SaveUrlOptions {
	/** Where the saved page is written. */
	documentsFolder: string;
	/** Opens the freshly-saved document in Reader, pairing it with the URL it came from. */
	onSaved: (path: string, url?: string) => void;
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (folder === "") return;

	const parts = folder.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const partial = parts.slice(0, i).join("/");
		if (app.vault.getAbstractFileByPath(partial)) continue;
		await app.vault.createFolder(partial).catch(() => {});
	}
}

/** A path nothing already occupies. */
function freePath(app: App, folder: string, base: string): string {
	const prefix = folder === "" ? "" : `${folder}/`;

	for (let n = 1; n < 200; n++) {
		const path = `${prefix}${base}${n === 1 ? "" : ` ${n}`}.html`;
		if (!app.vault.getAbstractFileByPath(path)) return path;
	}

	return `${prefix}${base} ${Date.now()}.html`;
}

/**
 * Fetch a URL and write it to the vault.
 *
 * Sanitised before it is written, not when it is read. Storing raw third-party HTML would mean
 * every later render has to be trusted to clean it; storing the cleaned form means the
 * dangerous shapes never reach disk.
 */
export async function saveUrl(app: App, url: string, options: SaveUrlOptions): Promise<string> {
	const { html, url: finalUrl } = await fetchPage(url);

	const parse = (source: string): Document => new DOMParser().parseFromString(source, "text/html");
	const raw = parse(html);
	const title = titleOf(raw, finalUrl);

	// Re-parsed through the article pipeline so what lands on disk is the same shape the reader
	// renders — and so an unreadable page fails here rather than after it is saved.
	const article = parseArticle(html, parse);
	const holder = document.implementation.createHTMLDocument("");
	const cleaned = article.sections
		.map((section) => sanitiseArticle(section.body, holder).innerHTML)
		.join("\n");

	if (cleaned.replace(/<[^>]+>/g, "").trim() === "") {
		throw new SaveUrlError("Nothing readable on that page — it may need JavaScript or a login.");
	}

	await ensureFolder(app, options.documentsFolder);
	const path = freePath(app, options.documentsFolder, fileNameFor(title, finalUrl));

	/*
	 * The source URL rides along as a comment.
	 *
	 * Not frontmatter — this is an `.html` file, not a note — but the reader reads it back to
	 * fill in the note's `url`, so a saved page still knows where it came from.
	 */
	await app.vault.create(path, `<!-- reader-source: ${finalUrl} -->\n${cleaned}\n`);

	return path;
}

/** The paste-a-URL dialog. */
export class SaveUrlModal extends Modal {
	private readonly options: SaveUrlOptions;
	private url = "";
	private busy = false;

	constructor(app: App, options: SaveUrlOptions) {
		super(app);
		this.options = options;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Save a page to Reader" });
		contentEl.createEl("p", {
			cls: "reader-setting-note",
			text:
				"Fetches the page once and writes it into your vault. From then on it is a local " +
				"file — readable offline, and clipped like anything else.",
		});

		const status = contentEl.createDiv({ cls: "reader-import-summary" });
		status.setText("Paste a link.");

		const input = contentEl.createEl("input", { type: "url", cls: "reader-url-input" });
		input.placeholder = "https://…";
		input.setAttribute("aria-label", "Page address to save");

		const save = async (): Promise<void> => {
			if (this.busy || this.url.trim() === "") return;
			this.busy = true;
			status.setText("Fetching…");

			try {
				const path = await saveUrl(this.app, this.url, this.options);
				this.close();
				new Notice(`Reader: saved ${path}`);
				this.options.onSaved(path, this.url.trim());
			} catch (error) {
				this.busy = false;
				status.setText(
					error instanceof SaveUrlError ? error.message : "That page could not be saved.",
				);
			}
		};

		input.addEventListener("input", () => {
			this.url = input.value;
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void save();
			}
		});

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("Save").setCta().onClick(() => void save()));

		/*
		 * Paste-and-go: the clipboard almost always already holds the link.
		 *
		 * Read once, when you open this box, and only used if it is an http(s) URL and you have
		 * not typed anything. Anything else is dropped on the spot — never stored, never written
		 * to disk, never sent anywhere. If the read is refused, the box is simply empty.
		 */
		window.setTimeout(() => {
			input.focus();
			void navigator.clipboard
				?.readText()
				.then((text) => {
					if (/^https?:\/\//i.test(text.trim()) && input.value === "") {
						input.value = text.trim();
						this.url = input.value;
						status.setText("From your clipboard — press Enter to save.");
					}
				})
				.catch(() => {});
		}, 0);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** The saved source URL, for a note's frontmatter. */
export async function sourceUrlOf(app: App, file: TFile): Promise<string | undefined> {
	const head = (await app.vault.read(file)).slice(0, 400);
	return /<!--\s*reader-source:\s*(\S+)\s*-->/.exec(head)?.[1];
}
