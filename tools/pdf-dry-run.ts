/**
 * Shape detection and note generation for any PDF, using poppler for extraction.
 *
 * The plugin uses Obsidian's pdf.js; this uses `pdftotext -bbox-layout` so the pure
 * classification, section and note code can be exercised on real files without Obsidian.
 *
 *   npm run pdf:dry-run -- ~/Downloads/Course\ Materials
 */

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { toLines, linesToText, type TextItem } from "../src/sources/slides/layout";
import { classifyShape } from "../src/sources/pdf/shape";
import { buildSections, outlineOf } from "../src/sources/document/structure";
import { buildDocumentBody, summarise } from "../src/sources/document/note";
import { buildSlides } from "../src/sources/slides/structure";

const execFileAsync = promisify(execFile);
const WORD = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
const PAGE = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;

const decode = (x: string): string =>
	x.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

async function extract(file: string): Promise<{ pages: TextItem[][]; sizes: { width: number; height: number }[] }> {
	const { stdout } = await execFileAsync("pdftotext", ["-bbox-layout", file, "-"], { maxBuffer: 256 * 1024 * 1024 });
	const pages: TextItem[][] = [];
	const sizes: { width: number; height: number }[] = [];

	for (const p of stdout.matchAll(PAGE)) {
		const width = Number(p[1]);
		const height = Number(p[2]);
		sizes.push({ width, height });
		const items: TextItem[] = [];
		for (const w of p[3].matchAll(WORD)) {
			const [, x1, y1, x2, y2, raw] = w;
			const text = decode(raw);
			if (text.trim() === "") continue;
			items.push({
				str: text,
				x: Number(x1),
				y: height - Number(y2),
				height: Number(y2) - Number(y1),
				width: Number(x2) - Number(x1),
			});
		}
		pages.push(items);
	}
	return { pages, sizes };
}

async function analyse(file: string, verbose: boolean): Promise<void> {
	const { pages, sizes } = await extract(file);
	const lines = pages.map(toLines);
	const chars = lines.reduce((n, page) => n + linesToText(page).length, 0) / Math.max(pages.length, 1);
	const verdict = classifyShape({ sizes, charactersPerPage: chars, pageCount: pages.length });

	const name = path.basename(file);
	if (verdict.shape === "document") {
		const sections = buildSections(lines);
		const s = summarise(sections);
		console.log(
			`${name.slice(0, 50).padEnd(52)} ${verdict.shape.padEnd(9)} ${String(pages.length).padStart(3)}p  ` +
				`sections:${String(s.sectionCount).padStart(3)} headings:${String(s.headings).padStart(3)}  (${verdict.reason})`,
		);
		if (verbose) {
			console.log(`\ndetected outline: ${outlineOf(sections).title ?? "(none)"}\n`);
			for (const sec of sections.slice(0, 14)) {
				console.log(`  ${String(sec.index).padStart(3)} L${sec.level} p${sec.page}  ${(sec.heading ?? "(body)").slice(0, 66)}`);
			}
			console.log(`\n${"=".repeat(92)}\nnote body, first 2 sections\n${"=".repeat(92)}`);
			console.log(buildDocumentBody(sections.slice(0, 2), { documentPath: `Sources/_decks/${name}` }));
		}
	} else {
		const slides = buildSlides(lines);
		console.log(
			`${name.slice(0, 50).padEnd(52)} ${verdict.shape.padEnd(9)} ${String(pages.length).padStart(3)}p  ` +
				`titled:${slides.filter((s) => s.title).length}/${slides.length}  (${verdict.reason})`,
		);
	}
}

async function main(): Promise<void> {
	const target = process.argv[2];
	if (!target) {
		console.error("usage: npm run pdf:dry-run -- <file.pdf | folder>");
		process.exit(1);
	}
	const info = await stat(target);
	if (info.isDirectory()) {
		const entries = (await readdir(target)).filter((e) => e.toLowerCase().endsWith(".pdf")).sort();
		for (const entry of entries) await analyse(path.join(target, entry), false);
		return;
	}
	await analyse(target, true);
}

main().catch((error) => {
	console.error("pdf dry run failed:", error);
	process.exit(1);
});
