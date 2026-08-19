/** Render one real file through the article pipeline, exactly as the view does. */
import { readFileSync } from "node:fs";
import { parseArticle, sectionText } from "../src/web/article";
import { sanitiseArticle } from "../src/web/sanitise";
import { createDom } from "./dom";
import { say } from "./report";

const { parse } = createDom();

const html = readFileSync(process.argv[2], "utf8");
const article = parseArticle(html, parse);
say("sections      ", article.sections.length);
say("title         ", article.title);

for (const s of article.sections) {
	const text = sectionText(s);
	say(`  s${s.index} textLen=${text.length} preview=${JSON.stringify(text.slice(0, 60))}`);

	const doc = parse("<body></body>");
	const out = sanitiseArticle(s.body, doc);
	say(`     sanitised childNodes=${out.childNodes.length} textLen=${(out.textContent ?? "").length}`);
	say(`     html=${JSON.stringify(out.innerHTML.slice(0, 120))}`);
}
