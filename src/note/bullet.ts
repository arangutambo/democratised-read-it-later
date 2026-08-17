/**
 * A clip, as one markdown bullet.
 *
 * This module is where the Live Preview constraint is enforced, so it is deliberately small
 * and heavily tested. The rule: **a bullet contains the clip and nothing else.** No page
 * number, no rectangle, no source path, no managed-region marker, no metadata of any kind.
 * Everything a machine needs lives in the `.reader` sidecar, keyed by the block id.
 *
 * The block id is the one piece of machinery that must stay in the file, because
 * `![[Note#^hl-01k9]]` — pulling a single clip into an essay — is the point of the whole
 * system. It is hidden visually by a `.cm-blockid` rule in `styles.css` rather than omitted.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import { blockId } from "../core/ids";
import type { Clip } from "../capture/types";

/** Indent for the writing space under a clip. A tab matches Obsidian's own list handling. */
const INDENT = "\t";

/**
 * The line you write on, under a clip.
 *
 * A nested bullet rather than a bare tab, so what you type is a list item in its own right —
 * it wraps, it nests further, and Enter gives you another one instead of falling out of the
 * list.
 */
const WRITING_LINE = `${INDENT}- `;

export interface BulletOptions {
	/**
	 * Placeholder line under the clip, indented, where the writing goes.
	 *
	 * Empty by default. An empty indented line is invisible in Live Preview but puts the
	 * cursor in the right place, which is the difference between a tool that invites writing
	 * and one that leaves you to find the spot yourself.
	 */
	placeholder?: string;
}

/**
 * One clip as one bullet, with an indented line underneath it for your own prose.
 *
 * Quote clips are rendered as a markdown blockquote inside the bullet so they read as the
 * source's words rather than yours — the same distinction the reader skin draws.
 */
export function renderBullet(clip: Clip, options: BulletOptions = {}): string {
	const id = blockId(clip.id);
	const placeholder = options.placeholder ?? "";

	if (clip.kind !== "quote") {
		return `- ![[${clip.assetPath ?? ""}]] ^${id}\n${WRITING_LINE}${placeholder}`;
	}

	/*
	 * A quote may be several lines, because a bulleted slide is a list and flattening it loses
	 * the shape that carried the meaning. Continuation lines are indented and re-prefixed with
	 * `>` so the whole thing stays one list item and one blockquote in Live Preview.
	 *
	 * The block id goes on the last line, which is where Obsidian looks for it.
	 */
	const lines = (clip.text ?? "").split("\n").map((line) => line.trimEnd()).filter((l) => l !== "");
	if (lines.length === 0) return `- > ^${id}\n${WRITING_LINE}${placeholder}`;

	const quoted = lines.map((line, i) => (i === 0 ? `- > ${line}` : `${INDENT}> ${line}`));
	quoted[quoted.length - 1] += ` ^${id}`;

	return `${quoted.join("\n")}\n${WRITING_LINE}${placeholder}`;
}

/**
 * Append a bullet to a note body.
 *
 * Append-only by construction: this takes the existing text and returns it with the bullet
 * added. It has no way to express "replace what was there", which is the point — the plugin
 * never rewrites what it wrote, so a hand-edit can never be clobbered and no conflict
 * machinery is needed in the note.
 */
export function appendBullet(body: string, clip: Clip, options: BulletOptions = {}): string {
	const bullet = renderBullet(clip, options);

	// A note that has never been written to, or one whose trailing whitespace the user has
	// trimmed, must not gain a leading blank line.
	if (body.trim() === "") return `${bullet}\n`;

	/*
	 * No blank line between clips.
	 *
	 * Consecutive items make one tight list, which is how a note of thirty clips stays
	 * readable — a blank line between each turns markdown's own list spacing loose and puts a
	 * gap wherever the cursor happens to be. Prose the user wrote keeps its own separation,
	 * because a blank line already there is left alone.
	 */
	const separator = body.endsWith("\n") ? "" : "\n";
	return `${body}${separator}${bullet}\n`;
}

/**
 * A line carrying one of our block ids, with the id captured.
 *
 * Not anchored to `- `, because a multi-line quote puts the id on its last continuation line.
 * Anchoring to the bullet made every structured clip invisible to the sort.
 */
const BULLET_LINE = /\^hl-([0-9a-zA-Z]+)\s*$/;

/** Where a clip sits in the document: which page, and where on it. */
export interface ClipPosition {
	page: number;
	/** Normalised distance from the top of the page, 0–1. */
	top: number;
	/** Normalised distance from the left, 0–1. */
	left: number;
}

/**
 * Two clips on the same visual line rarely have identical tops — a selection box and a dragged
 * box straddling the same row differ by a pixel or two. Within this tolerance they count as
 * the same line and sort left to right, which is how the page actually reads.
 *
 * 0.006 of page height is about 5pt on A4: under one line of body text, over any noise.
 */
const SAME_LINE = 0.006;

export function comparePositions(a: ClipPosition, b: ClipPosition): number {
	if (a.page !== b.page) return a.page - b.page;
	if (Math.abs(a.top - b.top) > SAME_LINE) return a.top - b.top;
	return a.left - b.left;
}

/** A locator's position. A clip with no rect — a whole page — sorts to the top of its page. */
export function positionOf(locator: Clip["locator"]): ClipPosition {
	return {
		page: locator.surface.index,
		top: locator.rect?.[1] ?? 0,
		left: locator.rect?.[0] ?? 0,
	};
}

/**
 * Where in the note a clip belongs, as a line index.
 *
 * Clips arrive in the order you make them, which is not the order the document reads in — you
 * clip a figure low on page 12, then go back for the definition at the top of page 3. Sorting
 * by page and then down the page means the note reads straight through afterwards.
 *
 * `positionAt` resolves a block id already in the note to its position. It comes from
 * `.reader`, deliberately: none of this may appear in the note, so it cannot be read back out
 * of one.
 *
 * Returns `lines.length` when the clip belongs at the end, which is the common case.
 */
export function insertionLineFor(
	lines: readonly string[],
	position: ClipPosition,
	positionAt: (blockId: string) => ClipPosition | undefined,
): number {
	for (let i = 0; i < lines.length; i++) {
		const match = BULLET_LINE.exec(lines[i]);
		if (!match) continue;

		const other = positionAt(match[1].toLowerCase());
		// A bullet whose locator is gone sorts nowhere; stepping over it keeps the rest in
		// order rather than piling everything in front of it.
		if (other === undefined) continue;

		// Insert before the *whole* bullet. A multi-line quote carries its id on the last
		// continuation line, and cutting in there would slice the bullet in half.
		if (comparePositions(other, position) > 0) return startOfBullet(lines, i);
	}
	return lines.length;
}

/**
 * Walk back from a line carrying a block id to the line that begins its bullet.
 *
 * A bullet starts at column zero; everything indented below it is a continuation — a quote's
 * later lines, or your own writing. Clips are a tight list with no blank lines between them,
 * so a blank line is no longer the boundary and indentation is what marks one.
 */
function startOfBullet(lines: readonly string[], at: number): number {
	for (let i = at; i >= 0; i--) {
		if (/^-\s/.test(lines[i])) return i;
		if (lines[i].trim() === "") break;
	}
	return at;
}

/**
 * Insert a bullet in page order.
 *
 * Still never rewrites: existing lines are only ever moved wholesale, never edited, so prose
 * indented under a bullet travels with it and a hand-edit cannot be clobbered. The plugin
 * gains the ability to write *between* existing bullets and nothing more.
 */
export function insertBulletInPageOrder(
	body: string,
	clip: Clip,
	positionAt: (blockId: string) => ClipPosition | undefined,
	options: BulletOptions = {},
): { body: string; line: number } {
	const bullet = renderBullet(clip, options);

	if (body.trim() === "") return { body: `${bullet}\n`, line: 1 };

	const lines = body.split("\n");
	const at = insertionLineFor(lines, positionOf(clip.locator), positionAt);

	if (at >= lines.length) {
		const next = appendBullet(body, clip, options);
		// The writing line is the last line before the trailing newline.
		return { body: next, line: Math.max(0, next.split("\n").length - 2) };
	}

	/*
	 * Cut straight in. Clips are a tight list, so there is no blank line to add or trim —
	 * which also removes the bug where trimming "blank" lines ate the writing line under the
	 * clip above, because a lone tab reports as blank to `trim()`.
	 */
	const before = lines.slice(0, at);
	const after = lines.slice(at);
	const inserted = bullet.split("\n");

	const merged = [...before, ...inserted, ...after];
	return { body: merged.join("\n"), line: before.length + inserted.length - 1 };
}
