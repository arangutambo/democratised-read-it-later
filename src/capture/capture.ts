/**
 * Turning a capture request into a clip.
 *
 * Pure: given a request, an id and a clock, this decides what the clip *is*. Writing the PNG
 * and appending the bullet happen elsewhere, so the decision is testable without a vault.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

import { ulid } from "../core/ids";
import type { Clip, CaptureRequest, NormalisedRect } from "./types";

export class CaptureError extends Error {}

/**
 * Six decimal places on a normalised coordinate is sub-pixel on any page anyone will ever
 * render, and it keeps the stored value clean.
 *
 * Without it, clamping produces float dust — `1 - 0.9` is `0.09999999999999998` — which then
 * gets serialised into `.reader`, compared for equality on reload, and shown in diffs.
 */
function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

/** Clamp to the unit square and drop degenerate boxes. */
export function normaliseRect(rect: NormalisedRect): NormalisedRect | undefined {
	const [rx, ry, rw, rh] = rect;
	if (![rx, ry, rw, rh].every((n) => Number.isFinite(n))) return undefined;

	// A drag that ends where it started, or a stray click, is not a clip. Without this a
	// mis-click writes a 0×0 PNG and a bullet pointing at nothing.
	const x = round(Math.min(Math.max(rx, 0), 1));
	const y = round(Math.min(Math.max(ry, 0), 1));
	const w = round(Math.min(Math.max(rw, 0), 1 - x));
	const h = round(Math.min(Math.max(rh, 0), 1 - y));

	return w <= 0 || h <= 0 ? undefined : [x, y, w, h];
}

/** Collapse runs of whitespace, so a quote pulled off a text layer reads as a sentence. */
export function tidyQuote(raw: string): string {
	return (
		raw
			// A PDF text layer emits a newline per line box, which turns a wrapped sentence into
			// a ragged column when it lands in the note.
			.replace(/\s+/g, " ")
			// Hyphenation across a line break is a rendering artefact, not part of the word.
			.replace(/(\w)-\s(\w)/g, "$1$2")
			.trim()
	);
}

/**
 * How much of this text the PDF could not express as characters.
 *
 * Maths typeset by LaTeX draws from Computer Modern fonts whose glyphs often carry no
 * meaningful Unicode mapping. Inline maths usually survives — `v · w = v1 w1 + v2 w2` comes
 * out readable, if flattened. **Displayed** maths does not: the stretchy brackets of a column
 * vector, big operators and matrix rules extract as replacement characters, private-use
 * codepoints or combining enclosures, and a selection over one lands in the note as
 * `v =⃝⃝⃝⃝⃝v1v2...vn⃝⃝⃝⃝⃝`.
 *
 * No amount of cleverness recovers those characters — they are not in the file. The useful
 * response is to notice and say so, because the region clip captures the same maths perfectly
 * as an image.
 */
export function unmappableRatio(text: string): number {
	const chars = [...text];
	if (chars.length === 0) return 0;

	let bad = 0;
	for (const ch of chars) {
		const c = ch.codePointAt(0) ?? 0;
		if (
			c === 0xfffd || // replacement character
			(c >= 0xe000 && c <= 0xf8ff) || // private use area
			(c >= 0x20d0 && c <= 0x20f0) || // combining diacritical marks for symbols
			(c >= 0xfff9 && c <= 0xfffb) // interlinear annotation
		) {
			bad++;
		}
	}
	return bad / chars.length;
}

/**
 * Above this, the quote is mostly glyphs rather than words and is not worth writing down.
 *
 * Deliberately not zero: a single stray glyph in an otherwise good sentence should still be
 * clippable, and a lone degree sign or ligature failure is not a reason to refuse.
 */
export const UNMAPPABLE_LIMIT = 0.15;

export interface CaptureContext {
	documentId: string;
	now?: () => number;
	newId?: () => string;
}

/**
 * The asset path is supplied rather than derived here: naming a file needs to know what
 * already exists in the vault, which is not a decision a pure function can make.
 */
export function makeClip(
	request: CaptureRequest,
	context: CaptureContext,
	assetPath?: string,
): Clip {
	const now = context.now ?? Date.now;
	const newId = context.newId ?? (() => ulid(now()));

	const rect = request.locator.rect ? normaliseRect(request.locator.rect) : undefined;
	const locator = { ...request.locator, ...(rect ? { rect } : {}) };
	if (request.locator.rect && !rect) delete locator.rect;

	const base = {
		id: newId(),
		documentId: context.documentId,
		created: new Date(now()).toISOString(),
		locator,
	};

	if (request.kind === "quote") {
		const text = tidyQuote(request.text ?? "");
		if (text === "") throw new CaptureError("Nothing was selected.");
		return { ...base, kind: "quote", text };
	}

	if (!assetPath) throw new CaptureError("An image clip needs somewhere to live.");
	return { ...base, kind: "image", assetPath };
}
