/**
 * The review queue: everything that needs a human, surfaced rather than swallowed.
 *
 * PLAN.md §1 decision 9 — failures are loud, in-vault and never silent. Three things land
 * here, and all three are states the plugin deliberately refused to resolve on its own:
 *
 *  - **needs-review** — an import whose metadata was too thin to trust.
 *  - **orphans** — highlights that could not be re-anchored. Kept, never deleted.
 *  - **conflicts** — `.conflict.md` siblings, written when a managed region was hand-edited.
 *
 * The queue is an Obsidian Base rather than a custom pane. Bases is native, needs no plugin
 * code, survives Reader being disabled, and matches how the vault already works. A dedicated
 * sidebar is the classic time sink and is deferred until the states have proven themselves.
 */

import { normalizePath, TFile, type App } from "obsidian";

import { joinVaultPath } from "../core/paths";

export const QUEUE_FILENAME = "Reader Queue.base";

export interface QueueEntry {
	path: string;
	title: string;
	reason: "needs-review" | "orphans" | "conflict";
	detail: string;
}

export interface QueueSummary {
	entries: QueueEntry[];
	needsReview: number;
	orphans: number;
	conflicts: number;
}

/**
 * Scan the sources folder for anything awaiting attention.
 *
 * Reads only the metadata cache, never file contents — this runs on a command and must not
 * touch the disk once per note across a 5,105-note vault.
 */
export function collectQueue(app: App, sourcesFolder: string): QueueSummary {
	const prefix = joinVaultPath(sourcesFolder);
	const entries: QueueEntry[] = [];
	let needsReview = 0;
	let orphans = 0;
	let conflicts = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		if (prefix !== "" && !file.path.startsWith(`${prefix}/`)) continue;

		if (file.path.endsWith(".conflict.md")) {
			conflicts++;
			entries.push({
				path: file.path,
				title: file.basename,
				reason: "conflict",
				detail: "Managed region was hand-edited; Reader wrote its version beside the note.",
			});
			continue;
		}

		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) continue;

		if (frontmatter.readerState === "needs-review") {
			needsReview++;
			entries.push({
				path: file.path,
				title: file.basename,
				reason: "needs-review",
				detail: "Imported metadata was too thin to trust.",
			});
		}

		const orphanCount = frontmatter.readerOrphans;
		if (typeof orphanCount === "number" && orphanCount > 0) {
			orphans += orphanCount;
			entries.push({
				path: file.path,
				title: file.basename,
				reason: "orphans",
				detail: `${orphanCount} highlight(s) could not be re-anchored.`,
			});
		}
	}

	entries.sort((a, b) => a.title.localeCompare(b.title));
	return { entries, needsReview, orphans, conflicts };
}

/**
 * The Base definition. Written verbatim, in the format Obsidian 1.9+ expects.
 *
 * Filters are expressions over **top-level** properties, which is why Reader's frontmatter
 * fields are flat rather than nested under a `reader:` key.
 */
export function queueBaseContent(): string {
	return `views:
  - type: table
    name: Needs review
    filters:
      or:
        - readerState == "needs-review"
        - readerOrphans > 0
    order:
      - file.name
      - readerState
      - readerOrphans
      - readerHighlights
    sort:
      - property: readerOrphans
        direction: DESC
      - property: file.name
        direction: ASC
  - type: table
    name: Reading
    filters:
      and:
        - readerState == "reading"
    order:
      - file.name
      - readerHighlights
      - readerImported
  - type: table
    name: Inbox
    filters:
      and:
        - readerState == "inbox"
    order:
      - file.name
      - readerType
      - readerHighlights
    sort:
      - property: readerImported
        direction: DESC
  - type: table
    name: Everything
    filters:
      and:
        - readerState != null
    order:
      - file.name
      - readerState
      - readerType
      - readerHighlights
      - readerOrphans
`;
}

/**
 * Create the queue Base if it is missing, and return its path.
 *
 * An existing file is left completely alone — the user will have customised their views, and
 * silently overwriting that would be exactly the behaviour the managed-region rules exist to
 * prevent, just in a different file.
 */
export async function ensureQueueBase(app: App, sourcesFolder: string): Promise<{ path: string; created: boolean }> {
	const path = normalizePath(joinVaultPath(sourcesFolder, QUEUE_FILENAME));
	const existing = app.vault.getAbstractFileByPath(path);

	if (existing instanceof TFile) return { path, created: false };

	await app.vault.create(path, queueBaseContent());
	return { path, created: true };
}
