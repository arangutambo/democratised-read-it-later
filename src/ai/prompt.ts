/**
 * Asking a model what is in a clipped region.
 *
 * The one job worth an API call: you drag a box around an equation or a table and get back
 * something you can actually write with — `$$…$$` for maths, markdown for a table — instead of
 * a PNG you can only look at. This is the answer to displayed maths being unrecoverable from a
 * PDF text layer, which `q` refuses above 15% unmappable and points at `r` for.
 *
 * Everything here is pure: the prompt, the request body, and the reading of the reply. The
 * network call is `anthropic.ts`, so the part that decides what to send and what to trust is
 * testable without a key.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** What the region is expected to hold. Named because the prompt differs materially. */
export type ExtractionKind = "auto" | "latex" | "table" | "text";

export interface ExtractionRequest {
	/** PNG bytes of the clipped region, already rendered at the clip DPI. */
	png: Uint8Array;
	kind: ExtractionKind;
	/** Surrounding text, when the page has any. Helps with symbols the image alone is unclear on. */
	context?: string;
}

/**
 * The model.
 *
 * Opus 5 rather than a cheaper tier: this runs once per region you deliberately drew a box
 * around, not in a loop, and a wrong subscript in a transcribed equation is worse than useless
 * — it is a note you will trust and act on. Cost per call is a fraction of a cent.
 */
export const MODEL = "claude-opus-5";

/**
 * Instructions, by kind.
 *
 * Deliberately narrow. The model is transcribing what is in the image, not explaining it,
 * summarising it, or improving it — anything else is generated content, which is what v1 was
 * rejected for. It returns nothing at all when the region holds no text.
 */
export function systemPromptFor(kind: ExtractionKind): string {
	const shared = [
		"You transcribe a clipped region of a document into markdown for a note.",
		"Transcribe only what is visible. Never explain, summarise, translate, correct, or add anything that is not in the image.",
		"If the region contains no readable text, reply with exactly: (no text)",
		"Reply with the transcription alone — no preamble, no code fence around the whole reply, no commentary.",
	];

	switch (kind) {
		case "latex":
			return [
				...shared,
				"The region is mathematics. Use LaTeX: $…$ for inline, $$…$$ on its own lines for displayed equations.",
				"Preserve subscripts, superscripts, and the exact symbols used — do not normalise notation.",
			].join(" ");
		case "table":
			return [...shared, "The region is a table. Use a markdown table, keeping the original column order."].join(" ");
		case "text":
			return [...shared, "The region is prose. Keep paragraph breaks and any list structure."].join(" ");
		default:
			return [
				...shared,
				"Choose the format that fits: LaTeX ($…$ or $$…$$) for mathematics, a markdown table for tabular data, otherwise plain markdown prose.",
			].join(" ");
	}
}

/** Base64 for a PNG, chunked so a large region does not blow the argument limit. */
export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;

	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}

	return btoa(binary);
}

/** The request body, ready to POST. */
export function buildRequest(request: ExtractionRequest): Record<string, unknown> {
	const content: Record<string, unknown>[] = [
		{
			type: "image",
			source: { type: "base64", media_type: "image/png", data: toBase64(request.png) },
		},
	];

	if (request.context && request.context.trim() !== "") {
		content.push({
			type: "text",
			// Marked as context so it is never mistaken for part of the region.
			text: `Surrounding text from the page, for disambiguation only:\n\n${request.context.slice(0, 2000)}`,
		});
	}

	content.push({ type: "text", text: "Transcribe the region in the image." });

	return {
		model: MODEL,
		// One region, one short answer. Generous enough for a full table, far below any timeout.
		max_tokens: 4096,
		system: systemPromptFor(request.kind),
		/*
		 * Thinking off, at low effort.
		 *
		 * Thinking is on by default on this model and `max_tokens` caps thinking plus reply
		 * together, so a transcription could be truncated by reasoning about an image that
		 * needs none. Disabling is allowed at `high` effort or below.
		 */
		thinking: { type: "disabled" },
		output_config: { effort: "low" },
		messages: [{ role: "user", content }],
	};
}

export class ExtractionError extends Error {}

/** Marks a region the model found nothing in. */
export const NO_TEXT = "(no text)";

/**
 * The transcription, or an error.
 *
 * `stop_reason` is checked before the content is read: a refusal returns HTTP 200 with an
 * empty content array, so indexing straight into `content[0]` throws on exactly the responses
 * that most need a clear message.
 */
export function readResponse(body: unknown): string {
	const response = body as {
		stop_reason?: string;
		content?: { type?: string; text?: string }[];
		error?: { message?: string };
	};

	if (response.error?.message) throw new ExtractionError(response.error.message);

	if (response.stop_reason === "refusal") {
		throw new ExtractionError("The model declined to transcribe that region.");
	}

	const text = (response.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("")
		.trim();

	if (text === "" || text === NO_TEXT) {
		throw new ExtractionError("No readable text in that region.");
	}

	// A model that fenced the whole reply despite being asked not to; unwrap rather than fail.
	const fenced = /^```(?:[a-z]*)\n([\s\S]*?)\n```$/i.exec(text);
	return (fenced ? fenced[1] : text).trim();
}
