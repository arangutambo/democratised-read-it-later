/**
 * Slides pipeline dry run against real decks.
 *
 *   npm run slides:dry-run -- ~/Downloads/BINF7001_2026_WEEK1_IntroductoryLecture.pdf
 *   npm run slides:dry-run -- ~/Downloads            # every PDF in a folder, summary only
 *
 * **This tool uses `pdftotext` (poppler, via homebrew); the plugin does not.** The plugin
 * uses Obsidian's own bundled pdf.js. The two produce the same shape of input — positioned
 * words — so the pure layout, structure and note-building code can be exercised against real
 * lecture slides here without an Obsidian instance. Only the extraction source differs.
 *
 * One real difference to be careful about: poppler's bounding boxes use a **top-left origin**
 * (y grows downward) while PDF and pdf.js use a **bottom-left origin** (y grows upward). The
 * y axis is flipped below so the pure code sees exactly what it will see in production.
 */

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { toLines, type TextItem } from "../src/sources/slides/layout";
import { buildDeckBody, summarise } from "../src/sources/slides/note";
import { buildSlides, outlineOf } from "../src/sources/slides/structure";

const execFileAsync = promisify(execFile);

const WORD = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
const PAGE = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;

function decode(xml: string): string {
	return xml
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/** Parse poppler's bbox XML into the same positioned-item shape pdf.js yields. */
async function extractWithPoppler(file: string): Promise<TextItem[][]> {
	const { stdout } = await execFileAsync("pdftotext", ["-bbox-layout", file, "-"], {
		maxBuffer: 256 * 1024 * 1024,
	});

	const pages: TextItem[][] = [];
	for (const pageMatch of stdout.matchAll(PAGE)) {
		const pageHeight = Number(pageMatch[2]);
		const items: TextItem[] = [];

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
				width: xMax - xMin,
			});
		}
		pages.push(items);
	}
	return pages;
}

async function analyse(file: string, verbose: boolean): Promise<void> {
	const pages = await extractWithPoppler(file);
	const slides = buildSlides(pages.map(toLines));
	const outline = outlineOf(slides);
	const summary = summarise(slides);

	const name = path.basename(file);
	console.log(
		`${name.slice(0, 52).padEnd(54)} ${String(summary.slideCount).padStart(3)} slides  ` +
			`title:${outline.counts.title} section:${String(outline.counts.section).padStart(2)} ` +
			`content:${String(outline.counts.content).padStart(3)} summary:${outline.counts.summary} ` +
			`blank:${outline.counts.blank}  ` +
			`titled:${slides.filter((s) => s.title).length}/${summary.slideCount}`,
	);

	if (!verbose) return;

	console.log(`\ndeck title detected: ${outline.title ?? "(none)"}\n`);
	console.log("detected structure:");
	for (const slide of slides.slice(0, 24)) {
		console.log(
			`  ${String(slide.index).padStart(3)}  ${slide.kind.padEnd(8)}  ${(slide.title ?? "—").slice(0, 64)}`,
		);
	}

	console.log(`\n${"=".repeat(90)}\nnote body, first 3 slides\n${"=".repeat(90)}`);
	console.log(buildDeckBody(slides.slice(0, 3), { deckPath: `Slides/${name}` }));
}

async function main(): Promise<void> {
	const target = process.argv[2];
	if (!target) {
		console.error("usage: npm run slides:dry-run -- <file.pdf | folder>");
		process.exit(1);
	}

	const info = await stat(target);

	if (info.isDirectory()) {
		const entries = (await readdir(target)).filter((e) => e.toLowerCase().endsWith(".pdf")).sort();
		console.log(`${entries.length} decks in ${target}\n`);
		for (const entry of entries) {
			try {
				await analyse(path.join(target, entry), false);
			} catch (error) {
				console.log(`${entry.slice(0, 54).padEnd(54)} FAILED: ${(error as Error).message.slice(0, 60)}`);
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
