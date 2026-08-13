/**
 * Slide deck → study note, end to end.
 *
 * The deck itself is copied into the vault. `![[deck.pdf#page=3]]` only resolves for a file
 * Obsidian can see, and embedding the real page is what makes the note worth opening. That
 * is a deliberate exception to PLAN.md §0.4's "originals stay outside the vault": a semester
 * of lecture slides is tens of megabytes against the 2.4 GB of images the vault already
 * carries, and copying avoids depending on the still-untested symlink behaviour. Large
 * binaries — full books, video — stay outside.
 *
 * Re-importing a deck updates each slide's extracted text in place and never touches a word
 * written between the slides. A slide whose region was hand-edited reports a conflict and is
 * left alone; the rest still update.
 */

import { normalizePath, TFile, TFolder, type App } from "obsidian";

import { baseCitekey } from "../../core/ids";
import { findRegion, writeRegion } from "../../core/managed-region";
import { joinVaultPath, sanitiseFileName } from "../../core/paths";
import { extractPdf, PdfUnavailableError, type PdfMetadata } from "./extract";
import { toLines } from "./layout";
import { buildDeckBody, slideRegionName, summarise } from "./note";
import { buildSlides, outlineOf, type Slide } from "./structure";

export { PdfUnavailableError };

export interface SlidesImportOptions {
	sourcesFolder: string;
	/** Vault-relative folder the deck PDFs are copied into. */
	decksFolder: string;
	includeText?: boolean;
	onProgress?: (stage: string, current: number, total: number) => void;
	signal?: AbortSignal;
}

export interface DeckImportResult {
	notePath: string;
	deckPath: string;
	title: string;
	slideCount: number;
	status: "created" | "updated" | "unchanged";
	/** Slides whose managed region was hand-edited and therefore left untouched. */
	conflicted: number[];
	warnings: string[];
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (folder === "") return;
	const segments = folder.split("/");
	let current = "";
	for (const segment of segments) {
		current = current === "" ? segment : `${current}/${segment}`;
		if (!(app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
			try {
				await app.vault.createFolder(current);
			} catch {
				// Already created, or appeared between the check and the call.
			}
		}
	}
}

/** A year in the filename or PDF metadata, used only to strengthen the citekey. */
function yearOf(fileName: string, metadata: PdfMetadata): number | undefined {
	const fromName = /\b(20\d{2})\b/.exec(fileName);
	if (fromName) return Number(fromName[1]);
	const fromMeta = metadata.creationDate ? /\b(20\d{2})\b/.exec(metadata.creationDate) : null;
	return fromMeta ? Number(fromMeta[1]) : undefined;
}

function frontmatter(fields: Record<string, string | number | undefined>): string {
	const lines = Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => (typeof value === "number" ? `${key}: ${value}` : `${key}: "${value}"`));
	return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Update an existing note slide by slide.
 *
 * Deliberately not a wholesale rewrite: everything between the regions is the reader's own
 * writing, and that is the entire product.
 */
function updateExisting(
	current: string,
	slides: readonly Slide[],
	includeText: boolean,
): { text: string; changed: boolean; conflicted: number[] } {
	let text = current;
	let changed = false;
	const conflicted: number[] = [];

	if (!includeText) return { text, changed, conflicted };

	for (const slide of slides) {
		if (slide.text === "") continue;
		const name = slideRegionName(slide.index);
		// Only touch regions this note already has; adding new ones would append them all at
		// the end, far from the slide they belong to.
		if (!findRegion(text, name)) continue;

		const quoted = slide.text
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
		const result = writeRegion(text, name, quoted);

		if (result.status === "conflict") conflicted.push(slide.index);
		else if (result.status === "updated") {
			text = result.text;
			changed = true;
		}
	}

	return { text, changed, conflicted };
}

export async function importDeck(
	app: App,
	source: { data: ArrayBuffer; fileName: string },
	options: SlidesImportOptions,
): Promise<DeckImportResult> {
	const { sourcesFolder, decksFolder, includeText = true } = options;
	const warnings: string[] = [];

	const extracted = await extractPdf(source.data, {
		signal: options.signal,
		onProgress: (page, total) => options.onProgress?.("extracting", page, total),
	});

	const slides = buildSlides(extracted.pages.map(toLines));
	const outline = outlineOf(slides);
	const stats = summarise(slides);

	if (stats.withText === 0) {
		warnings.push(
			"No text layer found — this deck is probably scanned images. Reader does not OCR yet, " +
				"so the note will have slides but no extracted text.",
		);
	}

	const baseName = source.fileName.replace(/\.pdf$/i, "");
	const title = outline.title ?? extracted.metadata.title ?? baseName;

	// Copy the deck in so the page embeds resolve.
	await ensureFolder(app, normalizePath(joinVaultPath(decksFolder)));
	const deckPath = normalizePath(joinVaultPath(decksFolder, `${sanitiseFileName(baseName)}.pdf`));
	if (!(app.vault.getAbstractFileByPath(deckPath) instanceof TFile)) {
		await app.vault.createBinary(deckPath, source.data);
	}

	await ensureFolder(app, normalizePath(joinVaultPath(sourcesFolder)));
	const notePath = normalizePath(joinVaultPath(sourcesFolder, `${sanitiseFileName(title, baseName)}.md`));
	const existing = app.vault.getAbstractFileByPath(notePath);

	if (existing instanceof TFile) {
		const current = await app.vault.read(existing);
		const { text, changed, conflicted } = updateExisting(current, slides, includeText);
		if (changed) await app.vault.modify(existing, text);

		if (conflicted.length > 0) {
			warnings.push(`Slides ${conflicted.join(", ")} were edited by hand and were left as they are.`);
		}

		return {
			notePath,
			deckPath,
			title,
			slideCount: stats.slideCount,
			status: changed ? "updated" : "unchanged",
			conflicted,
			warnings,
		};
	}

	const citekey = baseCitekey({
		author: extracted.metadata.author ?? undefined,
		year: yearOf(source.fileName, extracted.metadata),
		title,
	});

	const header = frontmatter({
		citekey,
		title,
		readerState: "inbox",
		readerType: "slides",
		readerSourceId: deckPath,
		readerSlides: stats.slideCount,
		readerOrphans: 0,
		readerDeck: deckPath,
		readerImported: new Date().toISOString(),
	});

	const body = buildDeckBody(slides, { deckPath, includeText });
	await app.vault.create(notePath, `${header}\n# ${title}\n\n![[${deckPath}]]\n\n${body}`);

	return {
		notePath,
		deckPath,
		title,
		slideCount: stats.slideCount,
		status: "created",
		conflicted: [],
		warnings,
	};
}

/** Read a PDF that already lives in the vault. */
export async function readVaultPdf(app: App, file: TFile): Promise<{ data: ArrayBuffer; fileName: string }> {
	return { data: await app.vault.readBinary(file), fileName: file.name };
}

/**
 * Read PDFs from a folder outside the vault — a downloads folder full of lecture slides.
 * Desktop only; the caller gates on `Platform.isDesktopApp` and imports this lazily.
 */
export async function readExternalPdfs(folder: string): Promise<{ data: ArrayBuffer; fileName: string }[]> {
	const { readdir, readFile } = await import("node:fs/promises");
	const path = await import("node:path");

	const entries = (await readdir(folder)).filter((e) => e.toLowerCase().endsWith(".pdf")).sort();
	const out: { data: ArrayBuffer; fileName: string }[] = [];

	for (const entry of entries) {
		const buffer = await readFile(path.join(folder, entry));
		out.push({
			data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
			fileName: entry,
		});
	}

	return out;
}
