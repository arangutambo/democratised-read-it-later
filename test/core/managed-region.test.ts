import { describe, expect, it } from "vitest";

import { contentHash } from "../../src/core/hash";
import { findRegion, stripRegion, writeRegion } from "../../src/core/managed-region";

const NAME = "highlights";

function withRegion(content: string, prose = "My own notes.\n\n"): string {
	return `${prose}%% reader:begin ${NAME} hash=${contentHash(content)} %%\n${content}\n%% reader:end ${NAME} %%\n`;
}

describe("managed regions", () => {
	describe("findRegion", () => {
		it("returns null when the region is absent", () => {
			expect(findRegion("just prose", NAME)).toBeNull();
		});

		it("extracts content and the declared hash", () => {
			const region = findRegion(withRegion("> a quote"), NAME);
			expect(region?.content).toBe("> a quote");
			expect(region?.declaredHash).toBe(contentHash("> a quote"));
			expect(region?.tampered).toBe(false);
		});

		it("handles an empty region", () => {
			const region = findRegion(withRegion(""), NAME);
			expect(region?.content).toBe("");
			expect(region?.tampered).toBe(false);
		});

		it("detects hand-edited content", () => {
			const text = withRegion("original").replace("original", "edited by hand");
			expect(findRegion(text, NAME)?.tampered).toBe(true);
		});

		it("treats a marker with no recorded hash as untampered", () => {
			// Someone typed the markers themselves; we adopt the region rather than fight it.
			const text = `%% reader:begin ${NAME} %%\nmine\n%% reader:end ${NAME} %%`;
			const region = findRegion(text, NAME);
			expect(region?.declaredHash).toBeNull();
			expect(region?.tampered).toBe(false);
		});

		it("ignores markers inside fenced code blocks", () => {
			// Documentation about the format is not a region. Getting this wrong would mean
			// the plugin overwrites a code sample in someone's note about the plugin.
			const text = [
				"Here is how it looks:",
				"",
				"```markdown",
				`%% reader:begin ${NAME} %%`,
				"example",
				`%% reader:end ${NAME} %%`,
				"```",
				"",
			].join("\n");
			expect(findRegion(text, NAME)).toBeNull();
		});

		it("finds a real region that follows a fenced example", () => {
			const text =
				"```\n" + `%% reader:begin ${NAME} %%\n` + "```\n\n" + withRegion("real content", "");
			expect(findRegion(text, NAME)?.content).toBe("real content");
		});

		it("does not match a differently named region", () => {
			expect(findRegion(withRegion("x"), "notes")).toBeNull();
		});
	});

	describe("writeRegion", () => {
		it("appends when no region exists, preserving the prose", () => {
			const result = writeRegion("My notes.\n", NAME, "> quote");
			expect(result.status).toBe("created");
			expect(result.text.startsWith("My notes.\n")).toBe(true);
			expect(findRegion(result.text, NAME)?.content).toBe("> quote");
		});

		it("creates a region in an empty note without leading blank lines", () => {
			const result = writeRegion("", NAME, "> quote");
			expect(result.text.startsWith("%% reader:begin")).toBe(true);
		});

		it("replaces content without touching surrounding prose", () => {
			const before = `Above.\n\n${withRegion("old", "")}\nBelow.\n`;
			const result = writeRegion(before, NAME, "new");

			expect(result.status).toBe("updated");
			expect(result.text).toContain("Above.");
			expect(result.text).toContain("Below.");
			expect(findRegion(result.text, NAME)?.content).toBe("new");
			expect(result.text).not.toContain("old");
		});

		it("reports unchanged when the content is identical", () => {
			const before = withRegion("same");
			const result = writeRegion(before, NAME, "same");
			expect(result.status).toBe("unchanged");
			expect(result.text).toBe(before);
		});

		it("refuses to overwrite hand-edited content", () => {
			// The single most important behaviour in this module.
			const before = withRegion("plugin wrote this").replace(
				"plugin wrote this",
				"and then I rewrote it myself",
			);

			const result = writeRegion(before, NAME, "plugin would write this");

			expect(result.status).toBe("conflict");
			expect(result.text).toBe(before);
			expect(result.conflictingContent).toBe("and then I rewrote it myself");
		});

		it("round-trips content containing marker-like text", () => {
			const tricky = "A line mentioning %% reader:end other %% inline.";
			const result = writeRegion("", NAME, tricky);
			expect(findRegion(result.text, NAME)?.content).toBe(tricky);
			expect(findRegion(result.text, NAME)?.tampered).toBe(false);
		});

		it("survives repeated writes of the same content", () => {
			let text = writeRegion("prose\n", NAME, "one").text;
			text = writeRegion(text, NAME, "two").text;
			const third = writeRegion(text, NAME, "two");

			expect(third.status).toBe("unchanged");
			expect(findRegion(third.text, NAME)?.content).toBe("two");
			expect(third.text.match(/reader:begin/g)).toHaveLength(1);
		});
	});

	describe("stripRegion", () => {
		it("returns only the user's own prose", () => {
			const text = `Mine.\n\n${withRegion("theirs", "")}`;
			expect(stripRegion(text, NAME).trim()).toBe("Mine.");
		});

		it("is a no-op when there is no region", () => {
			expect(stripRegion("Mine.", NAME)).toBe("Mine.");
		});
	});
});
