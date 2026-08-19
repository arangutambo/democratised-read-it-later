/** The transcript parser over a real imported Readwise transcript. */
import { readFileSync } from "node:fs";
import { parseCues, toParagraphs, clockOf, isTranscript } from "../src/video/transcript";
import { createDom } from "./dom";
import { say } from "./report";

const { parse } = createDom();

const html = readFileSync(process.argv[2], "utf8");
say("isTranscript      ", isTranscript(html));

const cues = parseCues(html, parse);
const paras = toParagraphs(cues);
const words = paras.reduce((n, p) => n + p.text.split(/\s+/).length, 0);

say("cues              ", cues.length);
say("paragraphs        ", paras.length);
say("words             ", words);
say("runs to           ", clockOf(cues[cues.length - 1]?.start ?? 0));
say("mean para words   ", Math.round(words / paras.length));
say("\nfirst three paragraphs:");
for (const p of paras.slice(0, 3)) {
	say(`  [${clockOf(p.start)}] ${p.text.slice(0, 100)}…`);
}
