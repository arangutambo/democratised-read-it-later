/**
 * The reader skin: a markdown post-processor that gives imported notes reading typography.
 *
 * Scope is deliberately narrow. Typography, measure and highlight treatment only — no
 * per-highlight colour rendering yet, because highlight colour meanings are user-defined and
 * ship empty (PLAN.md §0.2), so there is nothing to colour by until the user defines some.
 *
 * All tuning is exposed through Style Settings rather than hardcoded, so the measure and
 * font can be changed in the UI instead of by editing CSS.
 */

import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";

export const READER_CLASS = "reader-note";
export const HIGHLIGHT_CLASS = "reader-highlight";

const CONTAINER_SELECTOR = ".markdown-preview-view, .markdown-rendered";

/**
 * A note is a reader note when its frontmatter carries `reader: true` (the manual toggle) or
 * a `readerState` property (written by an importer).
 */
export function isReaderNote(frontmatter: unknown): boolean {
	if (frontmatter === null || typeof frontmatter !== "object") return false;
	const fields = frontmatter as Record<string, unknown>;
	// `reader: true` is the manual toggle; `readerState` is written by an importer.
	return fields.reader === true || typeof fields.readerState === "string";
}

/**
 * Removes the container class when the element is torn down.
 *
 * Preview containers are reused across notes, so without this a reader note followed by an
 * ordinary note would leave the ordinary note wearing reading typography.
 */
class ReaderScope extends MarkdownRenderChild {
	constructor(
		el: HTMLElement,
		private readonly container: Element,
	) {
		super(el);
	}

	override onunload(): void {
		if (!this.container.querySelector(`.${HIGHLIGHT_CLASS}`)) {
			this.container.classList.remove(READER_CLASS);
		}
	}
}

export function readerSkin(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
	const container = el.closest(CONTAINER_SELECTOR);
	const active = isReaderNote(ctx.frontmatter);

	if (!active) {
		// Always toggle rather than only add: the same container renders other notes later.
		container?.classList.remove(READER_CLASS);
		return;
	}

	if (container) {
		container.classList.add(READER_CLASS);
		ctx.addChild(new ReaderScope(el, container));
	}

	if (el.tagName === "BLOCKQUOTE") el.classList.add(HIGHLIGHT_CLASS);
	for (const quote of Array.from(el.querySelectorAll("blockquote"))) {
		// Callouts are blockquotes too, and they have their own styling to keep.
		if (!quote.classList.contains("callout")) quote.classList.add(HIGHLIGHT_CLASS);
	}
}
