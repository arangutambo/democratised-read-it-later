/**
 * Turning a prose document into a study note.
 *
 * Same principle as the slides note — the plugin owns the extracted text, the reader owns
 * the space around it — but organised by the document's own headings rather than by page.
 *
 * The PDF is embedded once at the top rather than per section, because a handout's pages are
 * not units of meaning: twenty page embeds through a seven-page worksheet is noise. Each
 * section instead carries a page link, so a reader can jump to the original passage.
 *
 * Pure — see PLAN.md §3.1.
 */

import { renderRegion } from "../../core/managed-region";
import type { Section } from "./structure";

export const SECTION_REGION_PREFIX = "section-";

export function sectionRegionName(index: number): string {
	return `${SECTION_REGION_PREFIX}${index}`;
}

export interface DocumentNoteOptions {
	/** Vault-relative path to the PDF. */
	documentPath: string;
	includeText?: boolean;
}

function quoted(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

export function buildDocumentBody(sections: readonly Section[], options: DocumentNoteOptions): string {
	const { documentPath, includeText = true } = options;
	const parts: string[] = [];

	for (const section of sections) {
		if (section.heading) {
			parts.push(`${"#".repeat(Math.min(section.level + 1, 4))} ${section.heading}`);
			parts.push("");
		}

		if (includeText && section.body !== "") {
			parts.push(renderRegion(sectionRegionName(section.index), quoted(section.body)));
			parts.push("");
		}

		// A link rather than an embed: the passage is worth reaching, but a page image every
		// few paragraphs would bury the prose.
		parts.push(`[page ${section.page}](${encodeURI(documentPath)}#page=${section.page})`);
		parts.push("");
		// The space the reader writes in.
		parts.push("");
	}

	return parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

export interface DocumentSummary {
	sectionCount: number;
	headings: number;
	withText: number;
}

export function summarise(sections: readonly Section[]): DocumentSummary {
	return {
		sectionCount: sections.length,
		headings: sections.filter((s) => s.heading).length,
		withText: sections.filter((s) => s.body !== "").length,
	};
}
