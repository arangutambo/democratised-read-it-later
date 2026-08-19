/**
 * Chunked resolution.
 *
 * PLAN.md §6: fuzzy-matching a 400-page book on the main thread will freeze Obsidian. There
 * is no Web Worker here — a worker would mean a second bundle and a serialisation boundary
 * for what is already fast enough when it yields — so instead the work is broken into chunks
 * that hand control back to the event loop between them, and it is cancellable.
 *
 * `setTimeout(0)` rather than a microtask: a resolved promise would let this monopolise the
 * loop through the microtask queue and never actually paint.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

import type { Highlight } from "../core/types";
import { resolveQuote, type Resolution, type ResolveOptions } from "./resolve";
import { normalise } from "./selector";

export class AbortError extends Error {
	constructor() {
		super("Re-anchoring was cancelled.");
		this.name = "AbortError";
	}
}

export interface ResolveAllOptions extends ResolveOptions {
	/** Highlights processed between yields. */
	chunkSize?: number;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
}

const DEFAULT_CHUNK_SIZE = 25;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

export interface ResolveAllResult {
	resolutions: Map<string, Resolution>;
	resolved: number;
	orphaned: number;
	ambiguous: number;
	byStrategy: Record<string, number>;
}

/**
 * Resolve many highlights against one document, yielding between chunks.
 *
 * Each highlight's own stored offsets seed its search, so re-anchoring an unedited document
 * takes the exact path on the first try.
 */
export async function resolveAll(
	doc: string,
	highlights: readonly Highlight[],
	options: ResolveAllOptions = {},
): Promise<ResolveAllResult> {
	const { chunkSize = DEFAULT_CHUNK_SIZE, signal, onProgress, ...resolveOptions } = options;

	// Hoisted out of the loop: normalising rebuilds the document and its index map, so doing
	// it per highlight is quadratic in the document size. See ResolveOptions.normalisedDoc.
	const normalisedDoc = normalise(doc);

	const resolutions = new Map<string, Resolution>();
	const byStrategy: Record<string, number> = {};
	let resolved = 0;
	let orphaned = 0;
	let ambiguous = 0;

	for (let i = 0; i < highlights.length; i++) {
		if (signal?.aborted) throw new AbortError();

		const highlight = highlights[i];
		const resolution = resolveQuote(doc, highlight.anchors.quote, {
			...resolveOptions,
			normalisedDoc,
			hint: highlight.anchors.offset ?? resolveOptions.hint,
		});

		resolutions.set(highlight.id, resolution);

		if (resolution.ok) {
			resolved++;
			byStrategy[resolution.strategy] = (byStrategy[resolution.strategy] ?? 0) + 1;
			if (resolution.ambiguous) ambiguous++;
		} else {
			orphaned++;
		}

		if ((i + 1) % chunkSize === 0) {
			onProgress?.(i + 1, highlights.length);
			await yieldToEventLoop();
		}
	}

	onProgress?.(highlights.length, highlights.length);
	return { resolutions, resolved, orphaned, ambiguous, byStrategy };
}

/**
 * Apply resolutions back onto highlights, marking failures `orphaned`.
 *
 * Orphans keep their text and anchors untouched — nothing is deleted. A highlight that
 * cannot be placed today may resolve tomorrow when the document is re-extracted, and the
 * user may want to re-attach it by hand in the meantime.
 */
export function applyResolutions(
	highlights: readonly Highlight[],
	resolutions: ReadonlyMap<string, Resolution>,
): Highlight[] {
	return highlights.map((highlight) => {
		const resolution = resolutions.get(highlight.id);
		if (!resolution) return highlight;

		if (!resolution.ok) return { ...highlight, state: "orphaned" };

		return {
			...highlight,
			state: "active",
			anchors: { ...highlight.anchors, offset: { start: resolution.start, end: resolution.end } },
		};
	});
}
