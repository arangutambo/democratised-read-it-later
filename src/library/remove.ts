/**
 * Taking a document off the shelf.
 *
 * Three files stand behind one row — the `.reader`, the companion note, and the document
 * itself — and they are not equally replaceable. The `.reader` is bookkeeping. The document
 * came from somewhere and may be your only copy. The note may have a semester of your writing
 * in it, and this plugin exists so that writing accumulates.
 *
 * So removal is two different actions rather than one, and neither of them ever deletes
 * outright: everything goes to trash by whatever route the vault is configured for, so a wrong
 * answer here is recoverable.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** What a removal would touch, so the confirmation can say it before it happens. */
export interface RemovalPlan {
	readerPath: string;
	notePath?: string;
	documentPath?: string;
	/** Characters of your own writing in the note, ignoring frontmatter and clip bullets. */
	writtenChars: number;
	/** Clips recorded against this document. */
	clips: number;
}

/**
 * How much of the note is yours.
 *
 * Frontmatter is the importer's, and a line beginning with a bullet is a clip this plugin
 * wrote. What is left is prose you typed, and it is the number that decides how loud the
 * confirmation should be.
 */
export function writtenCharsIn(note: string): number {
	const body = note.replace(/^---\n[\s\S]*?\n---\n?/, "");

	return body
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed === "") return false;
			// A clip bullet, or the writing line under one.
			return !/^[-*+]\s/.test(trimmed) && !/^!\[\[/.test(trimmed);
		})
		.join("")
		.trim().length;
}

/** The sentence shown before anything is trashed. */
export function describeRemoval(plan: RemovalPlan, everything: boolean): string {
	if (!everything) {
		return "The document and your note stay where they are. Only Reader's own file is removed, along with the record of where each clip came from.";
	}

	const parts = ["This moves the document, your note and Reader's file to trash."];

	if (plan.writtenChars > 0) {
		parts.push(`The note has roughly ${plan.writtenChars} characters of your own writing in it.`);
	}
	if (plan.clips > 0) {
		const one = plan.clips === 1;
		parts.push(`${plan.clips} clip${one ? "" : "s"} ${one ? "was" : "were"} taken from it.`);
	}

	return parts.join(" ");
}
