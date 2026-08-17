/**
 * Reading Zotero's databases. Desktop only — imported lazily, like the Books reader.
 *
 * Unlike Apple Books, `~/Zotero/` is **not** TCC-protected, so this needs no Full Disk
 * Access and works out of the box.
 *
 * Strictly read-only, per PLAN.md §0.3: annotations move out of Zotero once and never sync
 * back. Zotero keeps being the filing cabinet for PDFs and the source of `library.bib`.
 */

import { homedir } from "node:os";
import path from "node:path";

import {
	assertSqliteAvailable,
	exists,
	query,
	SqliteUnavailableError,
	withCopiedDatabases,
} from "../sqlite";
import type {
	ZoteroAnnotationRow,
	ZoteroCreatorRow,
	ZoteroFieldRow,
	ZoteroItemRow,
} from "./map";

export { assertSqliteAvailable };

export interface ZoteroPaths {
	/** Zotero's data directory — holds zotero.sqlite and storage/. */
	dataDir: string;
	library: string;
	betterBibtex?: string;
}

export class ZoteroUnavailableError extends SqliteUnavailableError {}

export async function locateZotero(dataDir = path.join(homedir(), "Zotero")): Promise<ZoteroPaths> {
	const library = path.join(dataDir, "zotero.sqlite");
	if (!(await exists(library))) {
		throw new ZoteroUnavailableError(
			`No Zotero library at ${library}. Set the Zotero data directory in Reader's settings ` +
				`if yours lives elsewhere (Zotero → Settings → Advanced → Files and Folders).`,
		);
	}

	const betterBibtex = path.join(dataDir, "better-bibtex.sqlite");
	return { dataDir, library, betterBibtex: (await exists(betterBibtex)) ? betterBibtex : undefined };
}

/**
 * Annotations, with the chain back to the work they belong to.
 *
 * An annotation's parent is the *attachment*, whose parent is the item that carries the
 * metadata — so it takes two joins to get from a highlight to its paper. Trashed items are
 * excluded: something the user deleted in Zotero should not reappear in their vault.
 */
const ANNOTATION_SQL = `
select
  a.itemID              as annotationID,
  ai.key                as itemKey,
  a.type                as type,
  a.text                as text,
  a.comment             as comment,
  a.color               as color,
  a.pageLabel           as pageLabel,
  a.sortIndex           as sortIndex,
  a.position            as position,
  at.parentItemID       as parentItemID,
  attKey.key            as attachmentKey,
  at.path               as attachmentPath,
  at.linkMode           as attachmentLinkMode
from itemAnnotations a
join items ai        on ai.itemID = a.itemID
join itemAttachments at on at.itemID = a.parentItemID
join items attKey    on attKey.itemID = at.itemID
where at.parentItemID is not null
  and a.itemID       not in (select itemID from deletedItems)
  and at.parentItemID not in (select itemID from deletedItems)
;`;

const ITEM_SQL = `
select i.itemID as itemID, i.key as key, it.typeName as typeName
from items i
join itemTypes it on it.itemTypeID = i.itemTypeID
where i.itemID not in (select itemID from deletedItems)
;`;

const FIELD_SQL = `
select id.itemID as itemID, f.fieldName as fieldName, idv.value as value
from itemData id
join itemDataValues idv on idv.valueID = id.valueID
join fields f           on f.fieldID   = id.fieldID
;`;

const CREATOR_SQL = `
select ic.itemID as itemID, c.firstName as firstName, c.lastName as lastName,
       c.fieldMode as fieldMode, ct.creatorType as creatorType
from itemCreators ic
join creators c      on c.creatorID = ic.creatorID
join creatorTypes ct on ct.creatorTypeID = ic.creatorTypeID
order by ic.itemID, ic.orderIndex
;`;

/**
 * Every PDF attachment and the item it belongs to.
 *
 * The annotation query already joins attachments, but only for items that *have* annotations.
 * Opening a paper in Reader needs the reverse lookup for any attachment at all, annotated or
 * not — most of a library is not annotated yet, and that is exactly what you are about to fix.
 */
const ATTACHMENT_SQL = `
select ia.itemID       as itemID,
       ia.parentItemID as parentItemID,
       ia.path         as path,
       ia.linkMode     as linkMode,
       i.key           as key
from itemAttachments ia
join items i on i.itemID = ia.itemID
where ia.parentItemID is not null
;`;

export interface ZoteroAttachmentRow {
	itemID: number;
	parentItemID: number;
	path: string | null;
	linkMode: number | null;
	key: string | null;
}

export interface ZoteroReadResult {
	items: ZoteroItemRow[];
	annotations: ZoteroAnnotationRow[];
	fields: ZoteroFieldRow[];
	creators: ZoteroCreatorRow[];
	/** Better BibTeX citation keys by itemID. Empty when BBT is not installed. */
	citekeys: Map<number, string>;
	attachments: ZoteroAttachmentRow[];
	warnings: string[];
}

export async function readZotero(paths: ZoteroPaths): Promise<ZoteroReadResult> {
	await assertSqliteAvailable();

	const sources = [paths.library, ...(paths.betterBibtex ? [paths.betterBibtex] : [])];

	return withCopiedDatabases(sources, async (copies) => {
		const [library, bbt] = copies;
		const warnings: string[] = [];

		const [annotations, items, fields, creators, attachments] = await Promise.all([
			query<ZoteroAnnotationRow>(library, ANNOTATION_SQL),
			query<ZoteroItemRow>(library, ITEM_SQL),
			query<ZoteroFieldRow>(library, FIELD_SQL),
			query<ZoteroCreatorRow>(library, CREATOR_SQL),
			query<ZoteroAttachmentRow>(library, ATTACHMENT_SQL).catch(() => [] as ZoteroAttachmentRow[]),
		]);

		const citekeys = new Map<number, string>();
		if (bbt) {
			try {
				const rows = await query<{ itemID: number; citationKey: string }>(
					bbt,
					"select itemID, citationKey from citationkey;",
				);
				for (const row of rows) citekeys.set(row.itemID, row.citationKey);
			} catch {
				// BBT's schema is its own; a change there must not stop the import.
				warnings.push("Better BibTeX database could not be read; Reader generated its own citekeys.");
			}
		} else {
			warnings.push(
				"Better BibTeX is not installed, so Reader generated its own citekeys. They will not " +
					"match a library.bib produced elsewhere.",
			);
		}

		return { items, annotations, fields, creators, citekeys, attachments, warnings };
	});
}
