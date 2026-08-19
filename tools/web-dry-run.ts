/** Dry run: the article parser over the real exported corpus. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArticle, sectionText, outlineOf } from "../src/web/article";
import { sanitiseArticle, BLOCKED_IMAGE_CLASS } from "../src/web/sanitise";
import { createDom } from "./dom";
import { say } from "./report";

/*
 * A fresh Window every so often.
 *
 * happy-dom keeps every document reachable from the window that made it, so 2,036 articles in
 * one process exhausts the heap. The plugin has one article open at a time; this is the
 * harness's problem, not the parser's.
 */
const dom = createDom();
const parse = dom.parse;
let sinceRecycle = 0;
const recycle = () => {
	if (++sinceRecycle < 50) return;
	sinceRecycle = 0;
	dom.recycle();
};

const dir = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".html"));

let sections = 0, titled = 0, noTitle = 0, blocked = 0, empty = 0, maxSections = 0, chars = 0;
const started = Date.now();

for (const file of files) {
	const html = readFileSync(path.join(dir, file), "utf8");
	const article = parseArticle(html, parse);
	sections += article.sections.length;
	maxSections = Math.max(maxSections, article.sections.length);
	if (article.title) titled++; else noTitle++;

	const text = article.sections.map(sectionText).join(" ");
	chars += text.length;
	if (text.trim() === "") empty++;

	const doc = parse("<body></body>");
	for (const section of article.sections) {
		const out = sanitiseArticle(section.body, doc);
		blocked += out.querySelectorAll(`.${BLOCKED_IMAGE_CLASS}`).length;
		if (out.querySelector("script")) throw new Error(`script survived in ${file}`);
	}
	void outlineOf(article.sections);
	recycle();
}

say(`files              ${files.length}`);
say(`sections           ${sections} (max ${maxSections} in one article, mean ${(sections/files.length).toFixed(1)})`);
say(`title from doc     ${titled}   |  no title in file: ${noTitle}`);
say(`remote imgs blocked ${blocked}`);
say(`articles w/ no text ${empty}`);
say(`text extracted     ${(chars/1e6).toFixed(2)} M chars`);
say(`elapsed            ${Date.now() - started} ms`);
