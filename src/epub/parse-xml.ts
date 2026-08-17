/**
 * Parsing an EPUB's XML.
 *
 * `text/xml`, not `application/xhtml+xml`. One of four real books declares itself with single
 * quotes — `<?xml version='1.0'?>` — and in XHTML mode that parse silently degrades to an
 * *HTML* document, where every query returns nothing and the book looks like it has no
 * sections. It fails quietly, which is the worst way for a format assumption to be wrong.
 *
 * The declaration is stripped as well: it is redundant once the string is in memory, and it is
 * the part parsers disagree about.
 */

export function parseXml(xml: string): Document {
	const withoutDeclaration = xml.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, "");
	return new DOMParser().parseFromString(withoutDeclaration, "text/xml");
}
