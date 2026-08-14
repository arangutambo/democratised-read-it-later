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
 * Markdown is line-oriented, so a quote containing a newline would break out of its bullet
 * and the rest would render as body text. `tidyQuote` already collapses whitespace; this is
 * the backstop for text arriving from anywhere else.
 */
function singleLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

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
	const body =
		clip.kind === "quote"
			? `> ${singleLine(clip.text ?? "")}`
			: `![[${clip.assetPath ?? ""}]]`;

	const placeholder = options.placeholder ?? "";
	return `- ${body} ^${id}\n${INDENT}${placeholder}`;
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

	// One blank line between clips: enough to separate them in Live Preview, not so much that
	// a note of thirty clips becomes a scroll.
	const separator = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
	return `${body}${separator}${bullet}\n`;
}
