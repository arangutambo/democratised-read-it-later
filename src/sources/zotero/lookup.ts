/**
 * Matching a PDF you are about to read to the Zotero item it belongs to.
 *
 * The point is citation identity: open a paper, and its note carries the same citekey Better
 * BibTeX put in `library.bib`, so a clip is citable as `[@citekey]` the moment it exists and
 * VimTeX's completion already knows the key.
 *
 * Reads only. Zotero keeps the storage, the PDFs and the `.bib`; §0.3's direction stands.
 */

import { basename } from "node:path";

import { makeCitekey } from "../../core/ids";
import { readZotero, locateZotero, type ZoteroReadResult } from "./db";
import { buildCsl, resolveAttachmentPath } from "./map";
import type { Csl } from "../../core/types";

export interface PaperMatch {
	citekey: string;
	csl: Csl;
	/** How the file was matched, so a weak match can be reported rather than assumed. */
	how: "path" | "filename";
	/**
	 * Where the citekey came from.
	 *
	 * Measured against a real library: only 14 of 95 items had a Better BibTeX key, because BBT
	 * only records one once it has been pinned or exported. Refusing the other 81 would mean
	 * most papers silently got no frontmatter, so Reader generates a key instead — but says so,
	 * because a generated key will **not** match `library.bib` and `\cite` will not resolve.
	 */
	citekeyFrom: "bibtex" | "reader";
}

/**
 * Index a library once, then answer lookups from it.
 *
 * Built as a class because opening a second paper in the same session must not copy and
 * re-read the whole SQLite database — that is a WAL copy plus four queries each time.
 */
export class ZoteroIndex {
	private readonly byPath = new Map<string, number>();
	private readonly byFilename = new Map<string, number>();
	private readonly csl = new Map<number, Csl>();
	private readonly citekeys = new Map<number, string>();
	/** Keys Reader has invented this session, so two papers cannot collide on one. */
	private readonly generated = new Set<string>();

	readonly warnings: string[];

	private constructor(read: ZoteroReadResult, dataDir: string) {
		this.warnings = read.warnings;

		const fieldsByItem = new Map<number, Map<string, string>>();
		for (const field of read.fields) {
			const map = fieldsByItem.get(field.itemID) ?? new Map<string, string>();
			map.set(field.fieldName, field.value);
			fieldsByItem.set(field.itemID, map);
		}

		const creatorsByItem = new Map<number, typeof read.creators>();
		for (const creator of read.creators) {
			creatorsByItem.set(creator.itemID, [...(creatorsByItem.get(creator.itemID) ?? []), creator]);
		}

		for (const item of read.items) {
			this.csl.set(
				item.itemID,
				buildCsl(item, fieldsByItem.get(item.itemID) ?? new Map(), creatorsByItem.get(item.itemID) ?? []),
			);
		}
		for (const [itemID, key] of read.citekeys) this.citekeys.set(itemID, key);

		for (const attachment of read.attachments) {
			const path = resolveAttachmentPath(
				{
					attachmentPath: attachment.path,
					attachmentKey: attachment.key,
					attachmentLinkMode: attachment.linkMode,
				},
				dataDir,
			);
			if (!path) continue;

			this.byPath.set(normalisePath(path), attachment.parentItemID);
			// A filename is a weaker key and collisions are real, so first one wins and the
			// match is reported as such.
			const name = basename(path).toLowerCase();
			if (!this.byFilename.has(name)) this.byFilename.set(name, attachment.parentItemID);
		}
	}

	/**
	 * Build an index from an already-read library.
	 *
	 * Exists so the matching can be tested without a Zotero installation — and specifically so
	 * the generated-key fallback is exercised at all: every live paper in the library this was
	 * written against already had a Better BibTeX key, so that branch would otherwise ship
	 * having never run.
	 */
	static fromRead(read: ZoteroReadResult, dataDir: string): ZoteroIndex {
		return new ZoteroIndex(read, dataDir);
	}

	static async open(dataDir?: string): Promise<ZoteroIndex> {
		const paths = await locateZotero(dataDir || undefined);
		const read = await readZotero(paths);
		return new ZoteroIndex(read, paths.dataDir);
	}

	/**
	 * The paper a PDF belongs to, if Zotero knows it.
	 *
	 * Falls back to matching on filename, because a deck or paper copied into the vault is no
	 * longer at the path Zotero recorded — and that copy is exactly what Reader opens.
	 */
	find(pdfPath: string): PaperMatch | undefined {
		const byPath = this.byPath.get(normalisePath(pdfPath));
		if (byPath !== undefined) return this.matchFor(byPath, "path");

		const byName = this.byFilename.get(basename(pdfPath).toLowerCase());
		return byName === undefined ? undefined : this.matchFor(byName, "filename");
	}

	private matchFor(itemID: number, how: PaperMatch["how"]): PaperMatch | undefined {
		const csl = this.csl.get(itemID);
		if (!csl) return undefined;

		const fromBibtex = this.citekeys.get(itemID);
		if (fromBibtex) return { citekey: fromBibtex, csl, how, citekeyFrom: "bibtex" };

		// Deterministic and generated once, the same way every other source here does it.
		const author = csl.author?.[0];
		const citekey = makeCitekey(
			{
				author: author?.literal ?? [author?.given, author?.family].filter(Boolean).join(" "),
				year: csl.issued?.["date-parts"]?.[0]?.[0],
				title: csl.title,
			},
			this.generated,
		);
		this.generated.add(citekey);

		return { citekey, csl, how, citekeyFrom: "reader" };
	}

}

/** Case-insensitive, separator-normalised. macOS paths differ in case but name one file. */
function normalisePath(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}
