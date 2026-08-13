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

/**
 * A deck title good enough to name a note after.
 *
 * Priority is filename-first in all but the clearest case, which is the opposite of what
 * seems natural, and the real corpus is why:
 *
 * - A **title-slide** title is best when it is substantial — "BINF7001 Advanced Genome
 *   Informatics Module 1" beats the filename. But one deck's title slide just reads "notes",
 *   which produced a note called `notes.md` with the citekey `personalnotes`.
 * - The **PDF metadata** Title is actively dangerous: several BINF7001 exports all carry
 *   "BINF7001_2026_WEEK1_allSlides" regardless of which week they are, so trusting it
 *   collapsed distinct decks onto one filename. It is now the last resort, not the second.
 * - The **filename** is the one thing guaranteed to differ between two files in a folder.
 */
export function pickTitle(deckTitle: string | undefined, metadataTitle: string | undefined, baseName: string): string {
	const substantial = (value: string | undefined): value is string =>
		value !== undefined && value.trim().length >= 8 && value.trim().split(/\s+/).length >= 2;

	if (substantial(deckTitle)) return deckTitle.trim();
	if (baseName.trim() !== "") return baseName.trim();
	if (substantial(metadataTitle)) return metadataTitle.trim();
	return "Untitled deck";
}

/**
 * A note path that belongs to this deck alone.
 *
 * Without this, two decks whose titles collide share a note: the second import finds the
 * first's file and rewrites its slide regions, so a note named after one lecture ends up
 * holding another's text. That happened to three of twenty-two real decks.
 *
 * The deck's own filename is appended only when the path is genuinely taken by a *different*
 * deck, so re-importing the same deck keeps writing to the same note.
 */
export function uniqueNotePath(app: App, sourcesFolder: string, title: string, baseName: string, sourceId: string): string {
	const candidate = (name: string): string =>
		normalizePath(joinVaultPath(sourcesFolder, `${sanitiseFileName(name, baseName)}.md`));

	const preferred = candidate(title);
	const existing = app.vault.getAbstractFileByPath(preferred);
	if (!(existing instanceof TFile)) return preferred;

	const owner = app.metadataCache.getFileCache(existing)?.frontmatter?.readerSourceId;
	if (owner === sourceId) return preferred;

	return candidate(`${title} (${baseName})`);
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
	const title = pickTitle(outline.title, extracted.metadata.title, baseName);

	// Copy the deck in so the page embeds resolve.
	await ensureFolder(app, normalizePath(joinVaultPath(decksFolder)));
	const deckPath = normalizePath(joinVaultPath(decksFolder, `${sanitiseFileName(baseName)}.pdf`));
	if (!(app.vault.getAbstractFileByPath(deckPath) instanceof TFile)) {
		await app.vault.createBinary(deckPath, source.data);
	}

	await ensureFolder(app, normalizePath(joinVaultPath(sourcesFolder)));
	const notePath = uniqueNotePath(app, sourcesFolder, title, baseName, deckPath);
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
