/**
 * The template variable contract.
 *
 * DESIGN.md §6: emit obsidian-zotero-integration's variable names **verbatim**, so existing
 * user templates — including every one already published online — work with no migration.
 * That is a compatibility contract, not an internal shape: renaming anything here silently
 * breaks other people's templates, so the names below are deliberately not "improved".
 *
 * Our own additions are namespaced under `reader.` to guarantee they can never collide with
 * a future Zotero Integration variable.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

import { blockId } from "../core/ids";
import type { Csl, CslName, Highlight, SourceRecord } from "../core/types";

/** One entry of `{% for annotation in annotations %}`. */
export interface AnnotationVariables {
	id: string;
	annotatedText: string;
	comment: string;
	colorCategory: string;
	color: string;
	page: string;
	date: string;
	/** Section or chapter the highlight sits in, where the source reports one. */
	chapter: string;
	imageRelativePath: string;
	attachment: { itemKey: string };
	/** Ours: the `^hl-…` block id, so a template can build `![[Note#^hl-…]]` embeds. */
	blockId: string;
	/** Ours: deep link back into the original application at this highlight. */
	link: string;
}

export interface TemplateVariables {
	title: string;
	citekey: string;
	authors: string;
	firstAuthor: string;
	year: string;
	publicationTitle: string;
	doi: string;
	url: string;
	abstractNote: string;
	allTags: string;
	itemType: string;
	pdfZoteroLink: string;
	annotations: AnnotationVariables[];
	reader: {
		sourceId: string;
		sourceType: string;
		libraryPath: string;
		deepLink: string;
		state: string;
		highlightCount: number;
		importedAt: string;
	};
}

export function formatName(name: CslName): string {
	if (name.literal) return name.literal;
	return [name.given, name.family].filter(Boolean).join(" ");
}

export function formatAuthors(csl: Csl): string {
	if (!csl.author || csl.author.length === 0) return "";
	return csl.author.map(formatName).join(", ");
}

export function yearOf(csl: Csl): string {
	const part = csl.issued?.["date-parts"]?.[0]?.[0];
	return part === undefined ? "" : `${part}`;
}

export interface ColourResolver {
	/** Maps a raw source key such as `books:3` to the user's name for it, or "". */
	(rawColour: string | undefined): { name: string; css: string };
}

export const noColours: ColourResolver = () => ({ name: "", css: "" });

export function buildVariables(
	source: SourceRecord,
	highlights: Highlight[],
	resolveColour: ColourResolver = noColours,
	importedAt: string = new Date().toISOString(),
): TemplateVariables {
	const csl = source.csl;

	return {
		title: source.title,
		citekey: source.citekey,
		authors: formatAuthors(csl),
		firstAuthor: csl.author?.[0] ? formatName(csl.author[0]) : "",
		year: yearOf(csl),
		publicationTitle: (csl["container-title"] as string) ?? "",
		doi: (csl.DOI as string) ?? "",
		url: (csl.URL as string) ?? source.deepLink ?? "",
		abstractNote: (csl.abstract as string) ?? "",
		allTags: "",
		itemType: csl.type,
		pdfZoteroLink: source.deepLink ?? "",
		annotations: highlights.map((h) => {
			const colour = resolveColour(h.colour);
			return {
				id: h.id,
				annotatedText: h.text,
				comment: h.note ?? "",
				colorCategory: colour.name,
				color: colour.css,
				page: "",
				date: h.created,
				chapter: h.chapter ?? "",
				imageRelativePath: "",
				attachment: { itemKey: source.id },
				blockId: blockId(h.id),
				link: h.anchors.cfi && source.deepLink ? `${source.deepLink}#${h.anchors.cfi}` : (source.deepLink ?? ""),
			};
		}),
		reader: {
			sourceId: source.id,
			sourceType: source.sourceType,
			libraryPath: source.libraryPath ?? "",
			deepLink: source.deepLink ?? "",
			state: source.state,
			highlightCount: highlights.length,
			importedAt,
		},
	};
}
