/**
 * Reading the Apple Books databases. Desktop and macOS only — callers must gate on
 * `Platform.isDesktopApp` and import this module lazily so mobile never evaluates it.
 *
 * Two decisions worth stating:
 *
 * 1. **Copy first, always.** PLAN.md §0.1: opening the live file with `immutable=1`, which
 *    DESIGN.md §8 called non-negotiable, makes SQLite ignore the write-ahead log — measured
 *    at 1,465 rows visible versus 1,542 actually present, and the 77 it drops are the most
 *    recent highlights. The `.sqlite`, `-wal` and `-shm` files are copied together and the
 *    copy is opened normally. The originals are never opened for writing.
 *
 * 2. **The system `sqlite3` binary**, not a bundled driver. Apple Books exists only on
 *    macOS, and macOS always ships `/usr/bin/sqlite3` (3.51 here, `-json` since 3.33). A
 *    native module like better-sqlite3 would need recompiling per Electron version — a
 *    distribution problem for a plugin shipped through the community store — and sql.js
 *    would add ~1.5 MB of WASM for a feature that cannot run on mobile anyway.
 */

import { execFile } from "node:child_process";
import { mkdtemp, copyFile, rm, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
	ANNOTATION_SPEC,
	ANNOTATION_TABLE,
	ASSET_SPEC,
	ASSET_TABLE,
	planSelect,
} from "./schema";
import type { BooksAnnotationRow, BooksAssetRow } from "./map";

const execFileAsync = promisify(execFile);

const SQLITE = "/usr/bin/sqlite3";
/** 1,177 highlights of book prose comfortably exceeds execFile's 1 MB default. */
const MAX_BUFFER = 128 * 1024 * 1024;

const ANNOTATION_DIR = "Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation";
const LIBRARY_DIR = "Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary";

export interface BooksDatabasePaths {
	annotations: string;
	library: string;
}

export class BooksUnavailableError extends Error {}

/**
 * Raised when macOS blocks the read rather than the data being absent.
 *
 * `~/Library/Containers/com.apple.iBooksX/` is TCC-protected: reading another application's
 * container requires Full Disk Access. Measured behaviour is worse than a plain EPERM — the
 * call can simply **never return**, which inside Obsidian would look exactly like the frozen
 * UI this plugin is written to avoid. Hence the timeout below, and hence a dedicated error
 * type carrying the fix rather than a generic failure.
 */
export class BooksPermissionError extends BooksUnavailableError {
	constructor(operation: string) {
		super(
			`macOS blocked Reader from reading the Apple Books library (${operation}).\n\n` +
				`Grant Obsidian Full Disk Access: System Settings → Privacy & Security → ` +
				`Full Disk Access → add Obsidian, then quit and reopen Obsidian.`,
		);
	}
}

/** Filesystem calls against the Books container can hang indefinitely without permission. */
const DEFAULT_TIMEOUT_MS = 10_000;

function isPermissionError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EPERM" || code === "EACCES";
}

/**
 * Reject rather than hang.
 *
 * The underlying operation cannot be cancelled — node's fs promises take no AbortSignal — so
 * it may still occupy a threadpool slot after we give up. That is the lesser evil: one
 * stalled slot is survivable, a permanently frozen Obsidian is not.
 */
async function withTimeout<T>(work: Promise<T>, operation: string, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new BooksPermissionError(operation)), ms);
			}),
		]);
	} catch (error) {
		if (isPermissionError(error)) throw new BooksPermissionError(operation);
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await withTimeout(access(target, constants.R_OK), `checking ${path.basename(target)}`);
		return true;
	} catch (error) {
		if (error instanceof BooksPermissionError) throw error;
		return false;
	}
}

/**
 * Apple versions these filenames (`AEAnnotation_v10312011_1727_local.sqlite`), so the
 * directory is globbed rather than the name hardcoded.
 */
async function findDatabase(dir: string, kind: string): Promise<string> {
	if (!(await exists(dir))) {
		throw new BooksUnavailableError(
			`Apple Books ${kind} folder not found at ${dir}. Open Books once, or check that this Mac has it installed.`,
		);
	}
	const entries = await withTimeout(readdir(dir), `listing ${kind} folder`);
	const candidates = entries.filter((e) => e.endsWith(".sqlite")).sort();
	if (candidates.length === 0) {
		throw new BooksUnavailableError(`No ${kind} database in ${dir}.`);
	}
	return path.join(dir, candidates[candidates.length - 1]);
}

export interface LocateOptions {
	home?: string;
	/**
	 * Explicit database paths, bypassing discovery.
	 *
	 * Used by `tools/books-dry-run.ts` to run the pipeline against a copy of the databases,
	 * which is also how the pipeline can be exercised on real data in environments where the
	 * live container is not readable.
	 */
	override?: Partial<BooksDatabasePaths>;
}

export async function locateDatabases(options: LocateOptions = {}): Promise<BooksDatabasePaths> {
	const home = options.home ?? homedir();
	const [annotations, library] = await Promise.all([
		options.override?.annotations ?? findDatabase(path.join(home, ANNOTATION_DIR), "annotation"),
		options.override?.library ?? findDatabase(path.join(home, LIBRARY_DIR), "library"),
	]);
	return { annotations, library };
}

export async function assertSqliteAvailable(): Promise<void> {
	if (!(await exists(SQLITE))) {
		throw new BooksUnavailableError(`${SQLITE} not found. The Apple Books importer needs macOS.`);
	}
}

/**
 * Copy the databases — including their WAL and shared-memory sidecars — into a temp
 * directory, run `fn` against the copies, then delete them. The originals are only ever read.
 */
export async function withCopiedDatabases<T>(
	paths: BooksDatabasePaths,
	fn: (copies: BooksDatabasePaths) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "obsidian-reader-books-"));
	try {
		const copies: BooksDatabasePaths = { annotations: "", library: "" };

		for (const key of ["annotations", "library"] as const) {
			const source = paths[key];
			const target = path.join(dir, path.basename(source));
			await withTimeout(copyFile(source, target), `copying ${path.basename(source)}`, 30_000);
			// Without these the copy is a stale snapshot; see the note at the top of this file.
			for (const suffix of ["-wal", "-shm"]) {
				if (await exists(source + suffix)) {
					await withTimeout(copyFile(source + suffix, target + suffix), `copying ${suffix}`, 30_000);
				}
			}
			copies[key] = target;
		}

		return await fn(copies);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function query<T>(dbPath: string, sql: string, attach?: { path: string; as: string }): Promise<T[]> {
	const script = attach ? `attach database '${attach.path.replace(/'/g, "''")}' as ${attach.as};\n${sql}` : sql;

	const { stdout } = await execFileAsync(SQLITE, ["-json", dbPath, script], {
		maxBuffer: MAX_BUFFER,
	});

	const trimmed = stdout.trim();
	if (trimmed === "") return [];
	return JSON.parse(trimmed) as T[];
}

async function tableColumns(dbPath: string, table: string): Promise<Set<string>> {
	const rows = await query<{ name: string }>(dbPath, `pragma table_info(${table});`);
	return new Set(rows.map((r) => r.name));
}

export interface BooksReadResult {
	assets: BooksAssetRow[];
	annotations: BooksAnnotationRow[];
	/** Optional columns absent from this macOS version's schema. Reported, never fatal. */
	warnings: string[];
}

export async function readBooks(copies: BooksDatabasePaths): Promise<BooksReadResult> {
	const warnings: string[] = [];

	const [annotationCols, assetCols] = await Promise.all([
		tableColumns(copies.annotations, ANNOTATION_TABLE),
		tableColumns(copies.library, ASSET_TABLE),
	]);

	const annotationPlan = planSelect(ANNOTATION_SPEC, annotationCols);
	const assetPlan = planSelect(ASSET_SPEC, assetCols);

	if (annotationPlan.fatal.length > 0 || assetPlan.fatal.length > 0) {
		throw new BooksUnavailableError(
			`Apple Books' schema has changed in a way this importer cannot handle. ` +
				`Missing required columns: ${[...annotationPlan.fatal, ...assetPlan.fatal].join(", ")}. ` +
				`Please report this with your macOS version.`,
		);
	}

	for (const [table, plan] of [
		[ANNOTATION_TABLE, annotationPlan],
		[ASSET_TABLE, assetPlan],
	] as const) {
		if (plan.missing.length > 0) {
			warnings.push(`${table}: columns not present on this macOS version — ${plan.missing.join(", ")}.`);
		}
	}

	// ZANNOTATIONDELETED is not in the spec because it is a filter, not imported data; it is
	// referenced defensively so a schema without it still returns rows.
	const deletedFilter = annotationCols.has("ZANNOTATIONDELETED")
		? "and ifnull(ZANNOTATIONDELETED, 0) = 0"
		: "";

	// Reading order, degrading through whichever ordering columns this schema still has.
	const orderBy = ["ZANNOTATIONASSETID", "ZPLABSOLUTEPHYSICALLOCATION", "ZANNOTATIONCREATIONDATE"]
		.filter((c) => annotationCols.has(c))
		.join(", ");

	const annotations = await query<BooksAnnotationRow>(
		copies.annotations,
		`select ${annotationPlan.selectList} from ${ANNOTATION_TABLE}
		 where ZANNOTATIONSELECTEDTEXT is not null
		   and trim(ZANNOTATIONSELECTEDTEXT) <> ''
		   ${deletedFilter}
		 ${orderBy ? `order by ${orderBy}` : ""};`,
	);

	const assets = await query<BooksAssetRow>(
		copies.library,
		`select ${assetPlan.selectList} from ${ASSET_TABLE};`,
	);

	return { assets, annotations, warnings };
}
