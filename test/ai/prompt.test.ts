import { describe, expect, it } from "vitest";

import {
	buildRequest,
	ExtractionError,
	MODEL,
	readResponse,
	systemPromptFor,
	toBase64,
} from "../../src/ai/prompt";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("systemPromptFor", () => {
	it("forbids anything but transcription", () => {
		// v1 was rejected for generating content; an explaining model is that mistake with a
		// vision call in front of it.
		const prompt = systemPromptFor("auto");

		expect(prompt).toContain("only what is visible");
		expect(prompt).toMatch(/never explain/i);
	});

	it("asks for LaTeX when the region is maths", () => {
		// The whole reason this exists: displayed maths is unrecoverable from a PDF text layer.
		expect(systemPromptFor("latex")).toContain("$$");
	});

	it("asks for a markdown table when the region is tabular", () => {
		expect(systemPromptFor("table")).toMatch(/markdown table/i);
	});

	it("lets the model choose on auto", () => {
		expect(systemPromptFor("auto")).toMatch(/choose the format/i);
	});

	it("always defines what an empty region means", () => {
		for (const kind of ["auto", "latex", "table", "text"] as const) {
			expect(systemPromptFor(kind)).toContain("(no text)");
		}
	});
});

describe("toBase64", () => {
	it("encodes bytes", () => {
		expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
	});

	it("handles an image too large for one call", () => {
		// A 150 DPI page region runs to hundreds of kilobytes; spreading it into one apply()
		// blows the argument limit.
		const big = new Uint8Array(200_000).fill(65);
		expect(toBase64(big).length).toBeGreaterThan(200_000);
	});
});

describe("buildRequest", () => {
	it("sends the image first, then the instruction", () => {
		const body = buildRequest({ png: PNG, kind: "auto" }) as {
			messages: { content: { type: string }[] }[];
		};

		expect(body.messages[0].content[0].type).toBe("image");
		expect(body.messages[0].content.at(-1)?.type).toBe("text");
	});

	it("uses the current model", () => {
		expect(buildRequest({ png: PNG, kind: "auto" }).model).toBe(MODEL);
		expect(MODEL).toBe("claude-opus-5");
	});

	it("turns thinking off", () => {
		/*
		 * Thinking is on by default on this model, and `max_tokens` caps thinking and reply
		 * together — so a transcription could be truncated by reasoning about an image that
		 * needs none. Disabling is permitted at `high` effort or below, hence `low`.
		 */
		const body = buildRequest({ png: PNG, kind: "auto" }) as {
			thinking: { type: string };
			output_config: { effort: string };
		};

		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.output_config.effort).toBe("low");
	});

	it("sends no sampling parameters", () => {
		// They are rejected outright on this model.
		const body = buildRequest({ png: PNG, kind: "auto" });

		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("top_p");
		expect(body).not.toHaveProperty("top_k");
	});

	it("marks page context as context, never as part of the region", () => {
		const body = buildRequest({ png: PNG, kind: "auto", context: "the surrounding words" }) as {
			messages: { content: { type: string; text?: string }[] }[];
		};
		const context = body.messages[0].content.find((b) => b.text?.includes("surrounding words"));

		expect(context?.text).toMatch(/disambiguation only/i);
	});

	it("omits context when there is none", () => {
		const body = buildRequest({ png: PNG, kind: "auto", context: "   " }) as {
			messages: { content: unknown[] }[];
		};

		expect(body.messages[0].content).toHaveLength(2);
	});
});

describe("readResponse", () => {
	const reply = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

	it("returns the transcription", () => {
		expect(readResponse(reply("$$e^{i\\pi} + 1 = 0$$"))).toBe("$$e^{i\\pi} + 1 = 0$$");
	});

	it("checks the stop reason before reading content", () => {
		// A refusal is HTTP 200 with an empty content array, so indexing content[0] throws on
		// exactly the responses that most need a clear message.
		expect(() => readResponse({ stop_reason: "refusal", content: [] })).toThrow(ExtractionError);
	});

	it("reports an API error rather than returning nothing", () => {
		expect(() => readResponse({ error: { message: "overloaded" } })).toThrow(/overloaded/);
	});

	it("says so when the region held no text", () => {
		expect(() => readResponse(reply("(no text)"))).toThrow(/no readable text/i);
		expect(() => readResponse(reply("   "))).toThrow(/no readable text/i);
	});

	it("unwraps a reply the model fenced anyway", () => {
		expect(readResponse(reply("```latex\n$$x^2$$\n```"))).toBe("$$x^2$$");
	});

	it("leaves a fenced code block inside a longer reply alone", () => {
		const text = "Some prose.\n\n```python\nprint(1)\n```";
		expect(readResponse(reply(text))).toBe(text);
	});
});
