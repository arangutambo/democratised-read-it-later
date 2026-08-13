"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// tools/slides-dry-run.ts
var import_node_child_process = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_node_util = require("node:util");

// src/sources/slides/layout.ts
var LINE_TOLERANCE = 3;
var SPACE_RATIO = 0.3;
function averageCharWidth(item) {
  if (item.width > 0 && item.str.length > 0) return item.width / item.str.length;
  return item.height * 0.5;
}
function joinItems(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = "";
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (i > 0) {
      const previous = sorted[i - 1];
      const gap = item.x - (previous.x + previous.width);
      const needsSpace = gap > averageCharWidth(previous) * SPACE_RATIO;
      const alreadySpaced = text.endsWith(" ") || item.str.startsWith(" ");
      if (needsSpace && !alreadySpaced) text += " ";
    }
    text += item.str;
  }
  return text.replace(/\s+/g, " ").trim();
}
function toLines(items) {
  const meaningful = items.filter((item) => item.str.trim() !== "");
  if (meaningful.length === 0) return [];
  const byHeight = [...meaningful].sort((a, b) => b.y - a.y);
  const groups = [];
  let current = [byHeight[0]];
  for (let i = 1; i < byHeight.length; i++) {
    const item = byHeight[i];
    if (Math.abs(item.y - current[0].y) <= LINE_TOLERANCE) current.push(item);
    else {
      groups.push(current);
      current = [item];
    }
  }
  groups.push(current);
  return groups.map((group) => ({
    text: joinItems(group),
    y: group[0].y,
    size: Math.max(...group.map((item) => item.height))
  })).filter((line) => line.text !== "");
}
function linesToText(lines) {
  return lines.map((line) => line.text).join("\n").trim();
}

// src/core/hash.ts
var OFFSET_BASIS = 2166136261;
var PRIME = 16777619;
function contentHash(input) {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 255;
    hash = Math.imul(hash, PRIME);
    const high = input.charCodeAt(i) >>> 8;
    if (high !== 0) {
      hash ^= high;
      hash = Math.imul(hash, PRIME);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// src/core/managed-region.ts
function renderRegion(name, content) {
  return `%% reader:begin ${name} hash=${contentHash(content)} %%
${content}
%% reader:end ${name} %%`;
}

// src/sources/slides/note.ts
var SLIDE_REGION_PREFIX = "slide-";
function slideRegionName(index) {
  return `${SLIDE_REGION_PREFIX}${index}`;
}
function embed(deckPath, page) {
  return `![[${deckPath}#page=${page}]]`;
}
function headingFor(slide) {
  const level = slide.kind === "section" || slide.kind === "summary" ? "##" : "###";
  const label = slide.title ?? `Slide ${slide.index}`;
  return `${level} ${slide.index}. ${label}`;
}
function quoted(text) {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}
function buildDeckBody(slides, options) {
  const { deckPath, skipBlank = true, includeText = true } = options;
  const parts = [];
  for (const slide of slides) {
    if (skipBlank && slide.kind === "blank") continue;
    parts.push(headingFor(slide));
    parts.push("");
    parts.push(embed(deckPath, slide.index));
    parts.push("");
    if (includeText && slide.text !== "") {
      parts.push(renderRegion(slideRegionName(slide.index), quoted(slide.text)));
      parts.push("");
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}
function summarise(slides) {
  return {
    slideCount: slides.length,
    sections: slides.filter((s) => s.kind === "section").length,
    blanks: slides.filter((s) => s.kind === "blank").length,
    withText: slides.filter((s) => s.text !== "").length
  };
}

// src/sources/slides/structure.ts
var SECTION_WORDS = /^(outline|overview|agenda|contents?|topics?|part\s+\w+|section\s+\w+|introduction|background|methods?|results?|discussion|today|this\s+week|learning\s+objectives?|objectives?|aims?)\b/i;
var SUMMARY_WORDS = /^(summary|conclusions?|recap|key\s+(points?|takeaways?)|takeaways?|wrap[\s-]?up|questions?|further\s+reading|references?|acknowledge?ments?|thank\s*you)\b/i;
var SPARSE_CHARS = 120;
var TITLE_SLIDE_MAX_LINES = 8;
var BULLET = /^\s*([-•▪◦*·‣]|\d+[.)]|[a-z][.)])\s+/i;
var TITLE_SIZE_RATIO = 1.15;
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function detectTitle(lines) {
  if (lines.length === 0) return void 0;
  const first = lines[0];
  const candidate = first.text.trim();
  if (candidate === "" || candidate.length > 120) return void 0;
  if (!/[A-Za-z]/.test(candidate)) return void 0;
  if (lines.length === 1) return candidate;
  const rest = lines.slice(1).map((line) => line.size);
  if (first.size >= median(rest) * TITLE_SIZE_RATIO) return candidate;
  if (candidate.length <= 60 && !/[.:;,]$/.test(candidate)) return candidate;
  return void 0;
}
function classify(lines, index, totalSlides) {
  const text = linesToText(lines);
  if (text === "") return "blank";
  const title = detectTitle(lines);
  const sparse = text.length < SPARSE_CHARS;
  if (title && SUMMARY_WORDS.test(title)) return "summary";
  if (title && sparse && SECTION_WORDS.test(title)) return "section";
  const bulleted = lines.some((line) => BULLET.test(line.text));
  if (index === 1 && lines.length <= TITLE_SLIDE_MAX_LINES && !bulleted) return "title";
  if (sparse && title && title.length === text.trim().length) {
    return index === totalSlides ? "summary" : "section";
  }
  return "content";
}
function buildSlides(pages) {
  return pages.map((lines, i) => {
    const index = i + 1;
    return {
      index,
      kind: classify(lines, index, pages.length),
      title: detectTitle(lines),
      text: linesToText(lines),
      lines: [...lines]
    };
  });
}
function deckTitleOf(slide) {
  if (!slide || slide.lines.length === 0) return void 0;
  const largest = Math.max(...slide.lines.map((line) => line.size));
  const parts = [];
  for (const line of slide.lines) {
    if (Math.abs(line.size - largest) > 0.5) break;
    parts.push(line.text.trim());
  }
  const title = parts.join(" ").replace(/\s+/g, " ").trim();
  return title === "" ? slide.title : title;
}
function outlineOf(slides) {
  const counts = { title: 0, section: 0, content: 0, summary: 0, blank: 0 };
  for (const slide of slides) counts[slide.kind]++;
  const titleSlide = slides.find((s) => s.kind === "title");
  return { slides: [...slides], title: deckTitleOf(titleSlide), counts };
}

// tools/slides-dry-run.ts
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var WORD = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
var PAGE = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
function decode(xml) {
  return xml.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
async function extractWithPoppler(file) {
  const { stdout } = await execFileAsync("pdftotext", ["-bbox-layout", file, "-"], {
    maxBuffer: 256 * 1024 * 1024
  });
  const pages = [];
  for (const pageMatch of stdout.matchAll(PAGE)) {
    const pageHeight = Number(pageMatch[2]);
    const items = [];
    for (const word of pageMatch[3].matchAll(WORD)) {
      const xMin = Number(word[1]);
      const yMin = Number(word[2]);
      const xMax = Number(word[3]);
      const yMax = Number(word[4]);
      const text = decode(word[5]);
      if (text.trim() === "") continue;
      items.push({
        str: text,
        x: xMin,
        // Flip to a bottom-left origin so this matches pdf.js.
        y: pageHeight - yMax,
        height: yMax - yMin,
        width: xMax - xMin
      });
    }
    pages.push(items);
  }
  return pages;
}
async function analyse(file, verbose) {
  const pages = await extractWithPoppler(file);
  const slides = buildSlides(pages.map(toLines));
  const outline = outlineOf(slides);
  const summary = summarise(slides);
  const name = import_node_path.default.basename(file);
  console.log(
    `${name.slice(0, 52).padEnd(54)} ${String(summary.slideCount).padStart(3)} slides  title:${outline.counts.title} section:${String(outline.counts.section).padStart(2)} content:${String(outline.counts.content).padStart(3)} summary:${outline.counts.summary} blank:${outline.counts.blank}  titled:${slides.filter((s) => s.title).length}/${summary.slideCount}`
  );
  if (!verbose) return;
  console.log(`
deck title detected: ${outline.title ?? "(none)"}
`);
  console.log("detected structure:");
  for (const slide of slides.slice(0, 24)) {
    console.log(
      `  ${String(slide.index).padStart(3)}  ${slide.kind.padEnd(8)}  ${(slide.title ?? "\u2014").slice(0, 64)}`
    );
  }
  console.log(`
${"=".repeat(90)}
note body, first 3 slides
${"=".repeat(90)}`);
  console.log(buildDeckBody(slides.slice(0, 3), { deckPath: `Slides/${name}` }));
}
async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npm run slides:dry-run -- <file.pdf | folder>");
    process.exit(1);
  }
  const info = await (0, import_promises.stat)(target);
  if (info.isDirectory()) {
    const entries = (await (0, import_promises.readdir)(target)).filter((e) => e.toLowerCase().endsWith(".pdf")).sort();
    console.log(`${entries.length} decks in ${target}
`);
    for (const entry of entries) {
      try {
        await analyse(import_node_path.default.join(target, entry), false);
      } catch (error) {
        console.log(`${entry.slice(0, 54).padEnd(54)} FAILED: ${error.message.slice(0, 60)}`);
      }
    }
    return;
  }
  await analyse(target, true);
}
main().catch((error) => {
  console.error("slides dry run failed:", error);
  process.exit(1);
});
