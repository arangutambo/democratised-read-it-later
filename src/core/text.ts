/**
 * Turning a value from somewhere untyped into text, without lying about it.
 *
 * Frontmatter, template filters and Obsidian's metadata cache all hand back `unknown` or `any`,
 * and the reflex — `String(value)` — writes `[object Object]` into a person's note when the
 * value turns out to be a map. That is not a crash, which is what makes it bad: it is a
 * plausible-looking wrong answer sitting in a file, and nobody notices until much later.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

/** Text for a value of unknown shape. Never `[object Object]`. */
export function asText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	if (value instanceof Date) return value.toISOString();

	// An object still has to become *something*. JSON is at least reversible and shows what it
	// was, which "[object Object]" does not.
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		// Circular, or a BigInt inside. Nothing useful is recoverable.
		return "";
	}
}
