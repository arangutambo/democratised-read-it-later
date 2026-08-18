/**
 * The one network call this plugin makes on your behalf.
 *
 * Through Obsidian's `requestUrl` rather than the Anthropic SDK: a plugin runs in the renderer,
 * where `fetch` to the API is blocked by CORS, and `requestUrl` is the sanctioned way out. It
 * also keeps the SDK's bulk out of a `main.js` that already carries pdf.js.
 *
 * Nothing here writes to the vault. It returns text; deciding what to do with it is the view's
 * job, and the answer is always to show it to you first.
 */

import { requestUrl } from "obsidian";

import { buildRequest, ExtractionError, readResponse, type ExtractionRequest } from "./prompt";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export interface ExtractOptions {
	apiKey: string;
	/** Abandons a call you have stopped waiting for. */
	signal?: AbortSignal;
}

/**
 * Transcribe a clipped region.
 *
 * Errors are messages, not stack traces: the caller shows them in a notice, and "your key is
 * wrong" needs to say so rather than surface a 401.
 */
export async function extractFromRegion(
	request: ExtractionRequest,
	options: ExtractOptions,
): Promise<string> {
	if (options.apiKey.trim() === "") {
		throw new ExtractionError("No API key set. Add one in Reader's settings, under AI.");
	}
	if (options.signal?.aborted) throw new ExtractionError("Cancelled.");

	let response: { status: number; json: unknown; text: string };

	try {
		response = await requestUrl({
			url: ENDPOINT,
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": options.apiKey,
				"anthropic-version": VERSION,
			},
			body: JSON.stringify(buildRequest(request)),
			// The error body is where the useful message lives; without this it throws instead.
			throw: false,
		});
	} catch (error) {
		throw new ExtractionError(
			`Could not reach the API: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (options.signal?.aborted) throw new ExtractionError("Cancelled.");

	if (response.status === 401) {
		throw new ExtractionError("That API key was rejected. Check it in Reader's settings.");
	}
	if (response.status === 429) {
		throw new ExtractionError("Rate limited by the API. Try again in a moment.");
	}
	if (response.status >= 500) {
		throw new ExtractionError(`The API is unavailable (${response.status}). Try again shortly.`);
	}

	return readResponse(response.json ?? {});
}
