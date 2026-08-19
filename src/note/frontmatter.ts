/**
 * Citation identity in a note's frontmatter.
 *
 * Every source Reader opens carries CSL-JSON and a citekey, so a clip is citable the moment it
 * exists — `[@cowan2001magical]` for anything destined for pandoc, `[[wikilink]]` for thinking.
 * This is the decision `DESIGN.md` §5.2 called the one that makes a Zotero replacement an
 * integration rather than a rewrite.
 *
 * **The citekey is written once and never recomputed.** Better BibTeX's history is the warning:
 * unstable keys silently break every draft that cites them, and you find out at submission. So
 * frontmatter is added to a note that has none and otherwise left entirely alone.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import type { Csl } from "../core/types";
import { asText } from "../core/text";

export interface PaperFrontmatter {
	citekey: string;
	csl: Csl;
}

/** Does this note already open with a frontmatter block? */
export function hasFrontmatter(body: string): boolean {
	return /^---\r?\n/.test(body);
}

/** Whether the note already records a citekey, in which case nothing here should touch it. */
export function hasCitekey(body: string): boolean {
	if (!hasFrontmatter(body)) return false;
	const end = body.indexOf("\n---", 3);
	const block = end === -1 ? body : body.slice(0, end);
	return /^citekey:\s*\S/m.test(block);
}

/** YAML-safe scalar. Quoted whenever it could otherwise be read as something else. */
function scalar(value: string): string {
	// Anything with a colon, a leading indicator character, or surrounding space needs quoting.
	const needsQuote = /^[\s>|@`&*!%#-]|[:#]\s|^$|\s$/.test(value) || /["'\\\n]/.test(value);
	return needsQuote ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/**
 * CSL-JSON as YAML, nested under `csl:`.
 *
 * Deliberately not the whole of CSL: only what is present, in a stable order, so the block
 * stays short enough to read past. Obsidian shows frontmatter as a properties panel, and forty
 * lines of bibliographic detail above your own writing is not what you opened the note for.
 */
function renderCsl(csl: Csl, indent = "  "): string[] {
	const lines: string[] = [];

	const put = (key: string, value: unknown): void => {
		if (value === undefined || value === null || value === "") return;
		lines.push(`${indent}${key}: ${scalar(asText(value))}`);
	};

	put("type", csl.type);
	put("title", csl.title);

	if (csl.author && csl.author.length > 0) {
		lines.push(`${indent}author:`);
		for (const name of csl.author) {
			const label = name.literal ?? [name.given, name.family].filter(Boolean).join(" ");
			if (label) lines.push(`${indent}  - ${scalar(label)}`);
		}
	}

	const year = csl.issued?.["date-parts"]?.[0]?.[0];
	put("year", year);
	put("container-title", csl["container-title"]);
	put("DOI", csl.DOI);
	put("URL", csl.URL);
	put("publisher", csl.publisher);

	return lines;
}

/**
 * Add citation frontmatter to a note that has none.
 *
 * Returns the body unchanged when the note already carries a citekey — the key is generated
 * once and stored forever, and a note you have already cited must not have it moved under you.
 *
 * A note that has frontmatter but no citekey is also left alone: merging into someone else's
 * YAML is how a plugin corrupts a file, and appending clips does not require it.
 */
export function withPaperFrontmatter(body: string, paper: PaperFrontmatter): string {
	if (hasFrontmatter(body)) return body;

	const block = ["---", `citekey: ${scalar(paper.citekey)}`, "csl:", ...renderCsl(paper.csl), "---", ""];
	return `${block.join("\n")}\n${body}`;
}
