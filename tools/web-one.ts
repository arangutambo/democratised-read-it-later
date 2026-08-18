/** Render one real file through the article pipeline, exactly as the view does. */
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { parseArticle, sectionText } from "../src/web/article";
import { sanitiseArticle } from "../src/web/sanitise";

const win = new Window();
const parse = (html: string): Document =>
	new (win as any).DOMParser().parseFromString(html, "text/html") as Document;

const html = readFileSync(process.argv[2], "utf8");
const article = parseArticle(html, parse);
console.log("sections      ", article.sections.length);
console.log("title         ", article.title);

for (const s of article.sections) {
	const text = sectionText(s);
	console.log(`  s${s.index} textLen=${text.length} preview=${JSON.stringify(text.slice(0, 60))}`);

	const doc = parse("<body></body>");
	const out = sanitiseArticle(s.body, doc);
	console.log(`     sanitised childNodes=${out.childNodes.length} textLen=${(out.textContent ?? "").length}`);
	console.log(`     html=${JSON.stringify((out as any).innerHTML?.slice(0, 120) ?? "")}`);
}
