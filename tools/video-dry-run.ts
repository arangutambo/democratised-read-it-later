/** The transcript parser over a real imported Readwise transcript. */
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { parseCues, toParagraphs, clockOf, isTranscript } from "../src/video/transcript";

const win = new Window();
const parse = (html: string): Document =>
	new (win as any).DOMParser().parseFromString(html, "text/html") as Document;

const html = readFileSync(process.argv[2], "utf8");
console.log("isTranscript      ", isTranscript(html));

const cues = parseCues(html, parse);
const paras = toParagraphs(cues);
const words = paras.reduce((n, p) => n + p.text.split(/\s+/).length, 0);

console.log("cues              ", cues.length);
console.log("paragraphs        ", paras.length);
console.log("words             ", words);
console.log("runs to           ", clockOf(cues[cues.length - 1]?.start ?? 0));
console.log("mean para words   ", Math.round(words / paras.length));
console.log("\nfirst three paragraphs:");
for (const p of paras.slice(0, 3)) {
	console.log(`  [${clockOf(p.start)}] ${p.text.slice(0, 100)}…`);
}
