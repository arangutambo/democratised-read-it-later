/**
 * Managed regions — the boundary between what the plugin owns and what you wrote.
 *
 *   %% reader:begin highlights hash=1a2b3c4d %%
 *   …plugin-generated, replaced wholesale on re-sync…
 *   %% reader:end highlights %%
 *
 * Three rules, from PLAN.md §4.1:
 *   1. Never write outside a marker pair.
 *   2. If the pair is missing, append — never guess where it should have gone.
 *   3. If the content between markers was hand-edited (the recorded hash no longer matches),
 *      report a conflict and write nothing. The caller saves a `.conflict.md` sibling.
 *
 * Marker matching is fence-aware: a marker inside a fenced code block is documentation about
 * the format, not a real marker, and must not be treated as one.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

import { contentHash } from "./hash";

const BEGIN = /^%%\s*reader:begin\s+([A-Za-z0-9_-]+)(?:\s+hash=([0-9a-f]+))?\s*%%\s*$/;
const END = /^%%\s*reader:end\s+([A-Za-z0-9_-]+)\s*%%\s*$/;
const FENCE = /^\s*(```|~~~)/;

export interface Region {
	name: string;
	/** Hash recorded when the plugin last wrote this region; null on a hand-made marker. */
	declaredHash: string | null;
	content: string;
	/** Offset of the first character of the begin marker line. */
	start: number;
	/** Offset just past the end marker line, excluding its trailing newline. */
	end: number;
	/** True when the content no longer hashes to `declaredHash`, i.e. it was hand-edited. */
	tampered: boolean;
}

export type WriteStatus = "created" | "updated" | "unchanged" | "conflict";

export interface WriteResult {
	text: string;
	status: WriteStatus;
	/** Present on a conflict: what the user had written, for the `.conflict.md` sibling. */
	conflictingContent?: string;
}

interface Line {
	text: string;
	start: number;
	end: number;
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (;;) {
		const nl = text.indexOf("\n", start);
		if (nl === -1) {
			lines.push({ text: text.slice(start), start, end: text.length });
			break;
		}
		lines.push({ text: text.slice(start, nl), start, end: nl });
		start = nl + 1;
	}
	return lines;
}

export function findRegion(text: string, name: string): Region | null {
	const lines = splitLines(text);
	let fence: string | null = null;
	let begin: { line: Line; hash: string | null } | null = null;

	for (const line of lines) {
		const fenceMatch = FENCE.exec(line.text);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence !== null) continue;

		if (begin === null) {
			const m = BEGIN.exec(line.text);
			if (m && m[1] === name) begin = { line, hash: m[2] ?? null };
			continue;
		}

		const e = END.exec(line.text);
		if (e && e[1] === name) {
			// Content excludes both marker lines and the newline that terminates the begin one.
			const contentStart = Math.min(begin.line.end + 1, line.start);
			const contentEnd = line.start === 0 ? 0 : line.start - 1;
			const content = contentEnd > contentStart ? text.slice(contentStart, contentEnd) : "";
			return {
				name,
				declaredHash: begin.hash,
				content,
				start: begin.line.start,
				end: line.end,
				tampered: begin.hash !== null && contentHash(content) !== begin.hash,
			};
		}
	}

	return null;
}

function render(name: string, content: string): string {
	return `%% reader:begin ${name} hash=${contentHash(content)} %%\n${content}\n%% reader:end ${name} %%`;
}

/**
 * Replace a region's contents, or append the region if it does not exist.
 *
 * Returns `conflict` and leaves `text` untouched when the existing content was hand-edited.
 * Overwriting there would silently destroy the user's writing, which is the one thing this
 * module exists to prevent.
 */
export function writeRegion(text: string, name: string, content: string): WriteResult {
	const region = findRegion(text, name);

	if (region === null) {
		const separator = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
		return { text: `${text}${separator}${render(name, content)}\n`, status: "created" };
	}

	if (region.tampered) {
		return { text, status: "conflict", conflictingContent: region.content };
	}

	if (region.content === content) return { text, status: "unchanged" };

	return {
		text: text.slice(0, region.start) + render(name, content) + text.slice(region.end),
		status: "updated",
	};
}

/** Everything outside the named region — the user's own prose. */
export function stripRegion(text: string, name: string): string {
	const region = findRegion(text, name);
	if (region === null) return text;
	return (text.slice(0, region.start) + text.slice(region.end)).replace(/\n{3,}/g, "\n\n");
}
