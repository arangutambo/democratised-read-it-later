/**
 * Reading clips back out of a note.
 *
 * The note is authoritative for what exists — decision F — so anything that needs to know
 * which clips a document has asks the note, not `.reader`. `.reader` knows only where each
 * clip came from, and deliberately nothing about what it is.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

export type ParsedKind = "quote" | "image";

export interface ParsedClip {
	/** Lowercased, as it appears after `^hl-`. */
	id: string;
	kind: ParsedKind;
	/** `kind: "image"` — the embedded path, exactly as written. */
	assetPath?: string;
	/** A short label for a picker: the quoted text, or the image's filename. */
	label: string;
	/** Line index of the bullet's first line, for ordering and for the cursor. */
	line: number;
}

const BLOCK_ID = /\^hl-([0-9a-zA-Z]+)\s*$/;
const IMAGE_EMBED = /!\[\[([^\]]+)\]\]/;

/**
 * Every clip the note still carries, in the order it reads.
 *
 * A multi-line quote carries its id on the last continuation line, so the scan walks back to
 * the `- ` that opens the bullet and takes its text from there.
 */
export function parseClips(body: string): ParsedClip[] {
	const lines = body.split("\n");
	const out: ParsedClip[] = [];

	for (let i = 0; i < lines.length; i++) {
		const match = BLOCK_ID.exec(lines[i]);
		if (!match) continue;

		const start = startOfBullet(lines, i);
		const first = lines[start];
		if (!/^\s*-\s/.test(first)) continue;

		const embed = IMAGE_EMBED.exec(first);
		if (embed) {
			const assetPath = embed[1];
			out.push({
				id: match[1].toLowerCase(),
				kind: "image",
				assetPath,
				label: assetPath.split("/").pop() ?? assetPath,
				line: start,
			});
			continue;
		}

		// A quote: take the whole bullet's text, stripped of its markup.
		const text = lines
			.slice(start, i + 1)
			.map((line) =>
				line
					.replace(BLOCK_ID, "")
					.replace(/^\s*-\s*/, "")
					.replace(/^\s*>\s?/, "")
					.trim(),
			)
			.filter((line) => line !== "")
			.join(" ");

		out.push({ id: match[1].toLowerCase(), kind: "quote", label: text, line: start });
	}

	return out;
}

function startOfBullet(lines: readonly string[], at: number): number {
	for (let i = at; i >= 0; i--) {
		if (/^\s*-\s/.test(lines[i])) return i;
		if (lines[i].trim() === "") break;
	}
	return at;
}
