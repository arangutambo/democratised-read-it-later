/**
 * The document's own structure, as headings in the note.
 *
 * A PDF's table of contents already says how the document is organised, so the note can
 * inherit that organisation instead of being a flat run of clips. Clip something in
 * "1.2 Vectors in Rⁿ" and the note grows a heading for it, in the right place, once.
 *
 * This is distinct from parents: a parent is a judgement you make, a heading is a fact about
 * the document. They compose — a parent nests clips under itself, inside whatever section
 * they belong to.
 *
 * Headings carry no machinery. `## 1.2 Vectors` is exactly what you would have typed, which
 * is why they are matched by their own text rather than by a hidden id.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** A section of the document, from its table of contents. */
export interface Section {
	title: string;
	/** 0 for a top-level section; deeper entries nest. */
	depth: number;
	/** First page of the section. */
	page: number;
}

/** `##` for depth 0, `###` for depth 1, and so on. */
export function headingFor(section: Section): string {
	// Starts at two so `#` stays free for a title of your own at the top of the note.
	const hashes = "#".repeat(Math.min(6, section.depth + 2));
	return `${hashes} ${section.title}`;
}

/**
 * The chain of sections a page falls in, outermost first.
 *
 * A section runs from its own first page until the next section at the same depth or
 * shallower — so page 40 of a textbook belongs to chapter 2 even though chapter 2's entry
 * names only page 31.
 */
export function sectionsForPage(outline: readonly Section[], page: number): Section[] {
	const chain: Section[] = [];

	for (const section of outline) {
		if (section.page > page) break;
		// A new section at this depth replaces the previous one, and drops anything deeper.
		chain.length = Math.min(chain.length, section.depth);
		chain[section.depth] = section;
	}

	return chain.filter((section) => section !== undefined);
}

/** Whether the note already carries this heading. */
export function hasHeading(lines: readonly string[], section: Section): boolean {
	const wanted = headingFor(section);
	return lines.some((line) => line.trim() === wanted);
}

export interface HeadingInsertion {
	lines: string[];
	/** How many lines were added, so the caller can keep its own indices straight. */
	added: number;
}

/**
 * Add any missing headings for `sections`, each in document order.
 *
 * `insertionLineFor` decides where each one goes, using the same ordering the clips use —
 * with a heading sorting to the very start of its own first page, so the clips on that page
 * land underneath it.
 *
 * Existing lines are never edited, only moved, which keeps the note's one safety property:
 * the plugin cannot clobber a hand-edit.
 */
export function ensureHeadings(
	lines: readonly string[],
	sections: readonly Section[],
	placeAt: (section: Section) => number,
): HeadingInsertion {
	let out = [...lines];
	let added = 0;
	/*
	 * Where the previous heading landed.
	 *
	 * A chapter and its first section routinely begin on the same page — "1 Vectors" and
	 * "1.1 Vectors in R2" both start at page 3 — so they resolve to the same insertion point
	 * and would stack in reverse, putting the subsection above its own chapter. Each heading
	 * therefore goes no earlier than just after the one before it.
	 */
	let floor = 0;

	for (const section of sections) {
		if (hasHeading(out, section)) continue;

		// `placeAt` measures the original lines, so shift it by what has been added since.
		const at = Math.max(floor, Math.min(placeAt(section) + added, out.length));
		const heading = headingFor(section);

		/*
		 * A heading needs a blank line above it to render, unless it opens the note. Below it
		 * needs nothing: the clips are a tight list and a gap there would undo that.
		 */
		/*
		 * A heading needs a blank line above it only when real content precedes it. After
		 * another heading it does not — a chapter and its first section read better adjacent,
		 * and markdown treats both as blocks either way.
		 */
		const previous = out[at - 1] ?? "";
		const needsGap = at > 0 && previous.trim() !== "" && !/^#{1,6}\s/.test(previous);
		const block = needsGap ? ["", heading] : [heading];

		out = [...out.slice(0, at), ...block, ...out.slice(at)];
		added += block.length;
		floor = at + block.length;
	}

	return { lines: out, added };
}
