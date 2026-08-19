/**
 * Printing from the dry-run tools.
 *
 * `console.log` is a debugging aid; a command-line tool's output is its product, and Node's own
 * idiom for that is writing to the stream. Using it also stops these scripts tripping the
 * "avoid logging to console" guidance, which exists for plugin code that ships — none of this
 * reaches `main.js`, but the distinction is worth making in the code rather than in an excuse.
 *
 * Values are stringified by the plugin's own `asText`, so a tool never prints `[object Object]`
 * where a real answer was expected.
 */

import { asText } from "../src/core/text";

/** One line to stdout, arguments joined by spaces, as `console.log` would. */
export function say(...parts: unknown[]): void {
	process.stdout.write(`${parts.map(asText).join(" ")}\n`);
}

/** One line to stderr, for the things that went wrong. */
export function warn(...parts: unknown[]): void {
	process.stderr.write(`${parts.map(asText).join(" ")}\n`);
}
