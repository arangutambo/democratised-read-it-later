/**
 * A Readwise document, as a note in the vault.
 *
 * The last step of leaving: 5,542 rows of someone else's database become ordinary markdown
 * files you own. Each note is a stub — what the thing was, where it came from, how far you got
 * — and where the document itself was exported too, a `.reader` pair beside it so it opens and
 * can be clipped like anything else.
 *
 * Deliberately not a transcript. v1's mistake was generating content; these notes carry
 * metadata and nothing else, and the words arrive when you clip them.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { ReadwiseDocument } from "./export";
import { stateFor } from "./export";

/** Vault paths reject these outright, and a colon silently breaks on Windows. */
export function sanitiseTitle(title: string): string {
	const cleaned = title.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();

	/*
	 * "Has nothing readable in it", not "is empty".
	 *
	 * A title of only punctuation survives replacement as a run of dashes — `///` becomes
	 * `---` — which is not empty, so a length check waves it through and the vault gets a file
	 * called `---`. In a note that also happens to be what frontmatter looks like.
	 */
	if (!/[\p{L}\p{N}]/u.test(cleaned)) return "Untitled";

	// Readwise titles run to whole sentences; a filesystem stops caring long before 120 chars.
	return cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
}

/**
 * The note's filename, carrying the Readwise id.
 *
 * The id is in the name because it is the only stable key: titles collide once sanitised, and
 * a second import must find the note it already wrote rather than making another. It is also
 * what matches the note to its file in the uploaded-files zip.
 */
export function noteNameFor(doc: ReadwiseDocument): string {
	return `${sanitiseTitle(doc.title)} (${doc.id}).md`;
}

function yaml(value: string): string {
	const needsQuote = /^[\s>|@`&*!%#-]|[:#]\s|^$|\s$/.test(value) || /["'\\\n]/.test(value);
	return needsQuote ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

export interface NoteOptions {
	/** Vault path of the document itself, when the export included the file. */
	documentPath?: string;
	/** Vault path of its `.reader`, when one was created. */
	readerPath?: string;
}

/**
 * One document as a note.
 *
 * `readerSourceId` is the Readwise id, which makes the note owned in exactly the sense
 * `note/ownership.ts` means: a second import recognises it, and the clip appender refuses to
 * write into it, so an imported stub and a capture note can never become the same file.
 */
export function buildNote(doc: ReadwiseDocument, options: NoteOptions = {}): string {
	const lines = ["---", `readerSourceId: ${yaml(`readwise:${doc.id}`)}`, `title: ${yaml(doc.title)}`];

	if (doc.url) lines.push(`url: ${yaml(doc.url)}`);
	if (doc.saved) lines.push(`saved: ${yaml(doc.saved)}`);

	lines.push(`readerState: ${yaml(stateFor(doc.location))}`);

	// Percentages read better in a properties panel than 0.37 does.
	if (doc.progress > 0) lines.push(`readerProgress: ${Math.round(doc.progress * 100)}`);
	if (options.documentPath) lines.push(`readerDocument: ${yaml(options.documentPath)}`);

	if (doc.tags.length > 0) {
		lines.push("tags:");
		for (const tag of doc.tags) lines.push(`  - ${yaml(tag)}`);
	}

	lines.push("---", "");

	/*
	 * A link to the reader, and nothing else.
	 *
	 * No summary, no extracted text, no scaffold of headings. The note is yours to write in,
	 * and anything generated here would be the transcript v1 was rejected for.
	 */
	if (options.readerPath) {
		lines.push(`[[${options.readerPath}|Open in Reader]]`, "");
	} else if (doc.url) {
		lines.push(`[${doc.title || doc.url}](${doc.url})`, "");
	}

	return lines.join("\n");
}

/** Where an imported document's own file goes, keeping the id so re-imports match. */
export function documentPathFor(doc: ReadwiseDocument, folder: string, extension: string): string {
	const prefix = folder === "" ? "" : `${folder}/`;
	return `${prefix}${sanitiseTitle(doc.title)} (${doc.id}).${extension}`;
}

/** The extension of a file in the uploaded-files zip. */
export function extensionOf(filename: string): string {
	const at = filename.lastIndexOf(".");
	return at === -1 ? "" : filename.slice(at + 1).toLowerCase();
}

/**
 * Whether Reader can open this kind of exported file.
 *
 * HTML is the bulk of an export — 5,479 of 5,524 files — and is now readable, which is what
 * makes the import worth running: without it an export is 44 documents and 2,000 links.
 */
export function readableExtension(extension: string): "pdf" | "epub" | "html" | undefined {
	if (extension === "pdf") return "pdf";
	if (extension === "epub") return "epub";
	if (extension === "html" || extension === "htm") return "html";
	return undefined;
}
