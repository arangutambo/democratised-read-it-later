/**
 * Nunjucks rendering.
 *
 * Real Nunjucks rather than a hand-rolled subset: the whole point of the variable contract in
 * `variables.ts` is that templates published for obsidian-zotero-integration work unchanged,
 * and those use filters, `{% if %}`, nested loops and whitespace control. A subset renderer
 * would be a compatibility claim we could not keep. It bundles to ~96 KB minified with no
 * node builtins, so it is safe on mobile too.
 *
 * `autoescape` is off: the output is markdown, not HTML, and escaping would mangle it.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

import nunjucks from "nunjucks";

import type { TemplateVariables } from "./variables";
import { asText } from "../core/text";

export class TemplateError extends Error {
	constructor(
		message: string,
		readonly templateName: string,
	) {
		super(message);
	}
}

function createEnvironment(): nunjucks.Environment {
	const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });

	/** Indent every line but the first — for dropping multi-line quotes into a list item. */
	env.addFilter("indent_rest", (value: unknown, spaces = 2) =>
		asText(value).replace(/\n/g, "\n" + " ".repeat(Number(spaces))),
	);

	/** Collapse a multi-line highlight to a single line, for headings and callout titles. */
	env.addFilter("oneline", (value: unknown) => asText(value).replace(/\s*\n\s*/g, " ").trim());

	/** Prefix every line with "> " so a highlight renders as a blockquote. */
	env.addFilter("blockquote", (value: unknown) =>
		asText(value)
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n"),
	);

	return env;
}

const environment = createEnvironment();

export function render(template: string, variables: TemplateVariables, templateName = "template"): string {
	try {
		return environment.renderString(template, variables);
	} catch (error) {
		throw new TemplateError(error instanceof Error ? error.message : String(error), templateName);
	}
}

/**
 * The body written inside the managed highlights region when no user template is configured.
 *
 * Each highlight is a blockquote carrying its own `^hl-…` block id, which is what makes a
 * single highlight quotable elsewhere via `![[Note#^hl-…]]` without duplicating its text.
 */
export const DEFAULT_HIGHLIGHTS_TEMPLATE = `{% for annotation in annotations %}{% if annotation.chapter and annotation.chapter != annotations[loop.index0 - 1].chapter or loop.first and annotation.chapter %}
### {{ annotation.chapter }}
{% endif %}
{% if annotation.orphaned %}> [!missing] Orphaned — this highlight no longer matches its source
{% endif %}{{ annotation.annotatedText | blockquote }}
{% if annotation.comment %}
{{ annotation.comment }}
{% endif %}{% if annotation.colorCategory %}
*{{ annotation.colorCategory }}*
{% endif %}
^{{ annotation.blockId }}
{% endfor %}`;

/**
 * Frontmatter and prose scaffold, written once when the note is first created.
 *
 * Reader's own fields are flat top-level properties rather than a nested `reader:` block.
 * The read-it-later queue is an Obsidian Base, and Bases filters are expressions over
 * top-level properties (`readerState == "needs-review"`); flat keys are also what Obsidian's
 * own Properties UI, search and Dataview all address directly. The nesting was tidier to
 * look at and worse at the one job the frontmatter has.
 */
export const DEFAULT_NOTE_TEMPLATE = `---
citekey: {{ citekey }}
title: "{{ title | oneline }}"
{% if authors %}authors: "{{ authors }}"
{% endif %}{% if year %}year: {{ year }}
{% endif %}readerState: {{ reader.state }}
readerType: {{ reader.sourceType }}
readerSourceId: "{{ reader.sourceId }}"
readerHighlights: {{ reader.highlightCount }}
readerOrphans: {{ reader.orphanCount }}
readerImported: {{ reader.importedAt }}
{% if reader.libraryPath %}readerLibraryPath: "{{ reader.libraryPath }}"
{% endif %}{% if reader.deepLink %}readerDeepLink: "{{ reader.deepLink }}"
{% endif %}csl:
  type: {{ itemType }}
  title: "{{ title | oneline }}"
{% if year %}  issued: { date-parts: [[{{ year }}]] }
{% endif %}---

# {{ title | oneline }}

{% if reader.deepLink %}[Open in {{ reader.deepLinkApp }}]({{ reader.deepLink }})
{% endif %}
## Notes


`;
