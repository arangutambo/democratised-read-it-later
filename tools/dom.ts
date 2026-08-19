/**
 * A DOM parser for the dry-run tools, typed in one place.
 *
 * happy-dom's `Document` is structurally the browser's but a different nominal type, so every
 * script that wanted to feed it to the plugin's own parsers was casting through `any` — five
 * copies of the same unchecked cast, each one an invitation to pass the wrong thing. There is
 * exactly one cast now, it is here, and it says what it is for.
 */

import { Window } from "happy-dom";

export interface ToolDom {
	/** Parse HTML the way the plugin's own `HtmlParser` callbacks expect. */
	parse: (html: string) => Document;
	/** Start again with a fresh window. happy-dom leaks across many documents. */
	recycle: () => void;
}

export function createDom(): ToolDom {
	let win = new Window();

	const parse = (html: string): Document =>
		// The one cast: happy-dom implements the DOM interfaces without declaring the DOM types.
		new win.DOMParser().parseFromString(html, "text/html") as unknown as Document;

	return {
		parse,
		recycle: () => {
			win = new Window();
		},
	};
}
