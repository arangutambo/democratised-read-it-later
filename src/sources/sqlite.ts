/**
 * Shared machinery for reading other applications' SQLite databases.
 *
 * Desktop only — importers that use this must be imported lazily and gated on
 * `Platform.isDesktopApp` so mobile never evaluates the node builtins below.
 *
 * Two rules live here rather than in each importer, because getting either wrong is a
 * correctness bug and two copies of them would drift:
 *
 * 1. **Copy first, including `-wal` and `-shm`.** Opening a live database with
 *    `immutable=1` makes SQLite ignore the write-ahead log. Measured on Apple Books that
 *    hid 77 of 1,542 rows — and they were the most recent annotations, the ones whose
 *    absence you would actually notice. Copy the sidecars or read stale data.
 * 2. **Time out rather than hang.** A TCC-protected path can make a filesystem call never
 *    return at all, which inside Obsidian is indistinguishable from a frozen app.
 *
 * The system `sqlite3` binary is used rather than a bundled driver: a native module would
 * need recompiling per Electron version, and sql.js would add ~1.5 MB of WASM for features
 * that cannot run on mobile anyway.
 */
import { assertDesktop } from "../platform/node";
import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Loaded only from desktop-gated call sites; this makes a mistake say so at once.
assertDesktop("sqlite.ts");

/*
 * Why the Node builtins below are imported statically.
 *
 * esbuild turns a *static* import of a builtin into `require()`, which Electron resolves
 * natively. A *dynamic* `await import("node:fs")` survives as a real ESM import, which the
 * renderer fetches as a URL — and Obsidian's `app://obsidian.md` origin turns that into a CORS
 * failure. So the rule's suggested fix is the thing that breaks.
 *
 * What keeps this off mobile is the *module* being imported lazily behind a
 * `Platform.isDesktopApp` check at every call site, which is checked at each of them.
 */

const execFileAsync = promisify(execFile);

export const SQLITE_BIN = "/usr/bin/sqlite3";

/** Long prose in many rows comfortably exceeds execFile's 1 MB default. */
const MAX_BUFFER = 128 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;
const COPY_TIMEOUT_MS = 30_000;

/** The database is missing, unreadable, or has a shape we cannot handle. */
export class SqliteUnavailableError extends Error {}

/** The operating system refused or stalled the read. Subclassed for per-source guidance. */
export class SqlitePermissionError extends SqliteUnavailableError {}

function isPermissionError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EPERM" || code === "EACCES";
}

/**
 * Reject rather than hang.
 *
 * The underlying operation cannot be cancelled — node's fs promises take no AbortSignal — so
 * it may still hold a threadpool slot after we give up. One stalled slot is survivable; a
 * permanently frozen Obsidian is not.
 */
export async function withTimeout<T>(
	work: Promise<T>,
	operation: string,
	ms: number = DEFAULT_TIMEOUT_MS,
	onDenied: (operation: string) => SqlitePermissionError = (op) =>
		new SqlitePermissionError(`The system blocked reading ${op}.`),
): Promise<T> {
	// A number, not a Node `Timeout`: this is the browser's timer, and `@types/node`
	// otherwise wins the inference and disagrees with what is actually returned.
	let timer: number | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(onDenied(operation)), ms);
			}),
		]);
	} catch (error) {
		if (isPermissionError(error)) throw onDenied(operation);
		throw error;
	} finally {
		if (timer !== undefined) window.clearTimeout(timer);
	}
}

export async function exists(target: string, onDenied?: (operation: string) => SqlitePermissionError): Promise<boolean> {
	try {
		await withTimeout(
			access(target, constants.R_OK),
			`checking ${path.basename(target)}`,
			DEFAULT_TIMEOUT_MS,
			onDenied,
		);
		return true;
	} catch (error) {
		if (error instanceof SqlitePermissionError) throw error;
		return false;
	}
}

export async function assertSqliteAvailable(): Promise<void> {
	if (!(await exists(SQLITE_BIN))) {
		throw new SqliteUnavailableError(`${SQLITE_BIN} not found. This importer needs macOS.`);
	}
}

/**
 * Copy each database — with its WAL and shared-memory sidecars — to a temp directory, run
 * `fn` against the copies, then delete them. Originals are only ever read.
 */
export async function withCopiedDatabases<T>(
	sources: readonly string[],
	fn: (copies: string[]) => Promise<T>,
	onDenied?: (operation: string) => SqlitePermissionError,
): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "obsidian-reader-"));
	try {
		const copies: string[] = [];

		for (const source of sources) {
			const target = path.join(dir, path.basename(source));
			await withTimeout(
				copyFile(source, target),
				`copying ${path.basename(source)}`,
				COPY_TIMEOUT_MS,
				onDenied,
			);
			// Without these the copy is a stale snapshot. See the note at the top of this file.
			for (const suffix of ["-wal", "-shm"]) {
				if (await exists(source + suffix, onDenied)) {
					await withTimeout(
						copyFile(source + suffix, target + suffix),
						`copying ${suffix}`,
						COPY_TIMEOUT_MS,
						onDenied,
					);
				}
			}
			copies.push(target);
		}

		return await fn(copies);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function query<T>(dbPath: string, sql: string): Promise<T[]> {
	const { stdout } = await execFileAsync(SQLITE_BIN, ["-json", dbPath, sql], { maxBuffer: MAX_BUFFER });
	const trimmed = stdout.trim();
	return trimmed === "" ? [] : (JSON.parse(trimmed) as T[]);
}

export async function tableColumns(dbPath: string, table: string): Promise<Set<string>> {
	const rows = await query<{ name: string }>(dbPath, `pragma table_info(${table});`);
	return new Set(rows.map((r) => r.name));
}
