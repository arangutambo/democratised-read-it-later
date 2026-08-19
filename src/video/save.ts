/**
 * A YouTube video as a document you own.
 *
 * The transcript is fetched once and written into the vault, in the same per-phrase shape the
 * Readwise export uses — so a video saved today and a video exported from Readwise two years ago
 * are the same kind of file, open in the same surface, and clip with the same keys. Nothing
 * downstream has to learn a second format.
 *
 * What is written is the words and their moments, not the video. The picture stays on YouTube,
 * which is where it has to be; the transcript is the part worth owning, because it is the part
 * you quote and the part you search.
 */

import { normalizePath, type App } from "obsidian";

import { TRANSCRIPT_MARKER } from "./transcript";

/** One phrase and the second it was said, as the library hands it over. */
export interface FetchedCue {
	start: number;
	text: string;
}

export interface FetchedTranscript {
	videoId: string;
	title: string;
	author: string;
	durationSeconds: number;
	cues: readonly FetchedCue[];
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * The transcript as a document the reader already understands.
 *
 * The marker attribute goes on every span rather than only the wrapper, because that is what
 * `parseCues` selects on — and matching the existing shape exactly is the whole point of writing
 * it this way rather than inventing a format.
 */
export function transcriptDocument(transcript: FetchedTranscript, url: string): string {
	const spans = transcript.cues
		.map(
			(cue) =>
				`<span ${TRANSCRIPT_MARKER}="1" data-rw-start="${cue.start}">${escapeHtml(cue.text)}</span>`,
		)
		.join("\n");

	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		`<title>${escapeHtml(transcript.title)}</title>`,
		`<meta name="author" content="${escapeHtml(transcript.author)}">`,
		`<link rel="canonical" href="${escapeHtml(url)}">`,
		"</head>",
		"<body>",
		`<article ${TRANSCRIPT_MARKER}="1" data-rw-video-id="${escapeHtml(transcript.videoId)}">`,
		`<h1>${escapeHtml(transcript.title)}</h1>`,
		`<p>${spans}</p>`,
		"</article>",
		"</body>",
		"</html>",
	].join("\n");
}

/** Characters a vault will not take in a file name. */
function sanitiseName(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	return (cleaned === "" ? "YouTube video" : cleaned).slice(0, 80);
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
		const path = normalizePath(`${prefix}${base}${n === 1 ? "" : ` ${n}`}.html`);
		if (!app.vault.getAbstractFileByPath(path)) return path;
	}

	return normalizePath(`${prefix}${base} ${Date.now()}.html`);
}

export interface SavedTranscript {
	path: string;
	title: string;
	videoId: string;
	cues: number;
}

/**
 * Write a fetched transcript into the vault.
 *
 * Deliberately separate from fetching it. The network half needs a webview and is desktop-only;
 * this half is ordinary file writing, and keeping them apart is what lets the document format be
 * tested without a browser anywhere near it.
 */
export async function writeTranscript(
	app: App,
	transcript: FetchedTranscript,
	url: string,
	documentsFolder: string,
): Promise<SavedTranscript> {
	await ensureFolder(app, documentsFolder);

	const path = freePath(app, documentsFolder, sanitiseName(transcript.title));
	await app.vault.create(path, transcriptDocument(transcript, url));

	return { path, title: transcript.title, videoId: transcript.videoId, cues: transcript.cues.length };
}
