/** Levelled logging behind a setting. No `obsidian` import — unit-testable in plain Node. */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

const RANK: Record<LogLevel, number> = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

export interface LogSink {
	error(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	log(...args: unknown[]): void;
}

export class Logger {
	constructor(
		private readonly prefix: string,
		private level: LogLevel = "warn",
		private readonly sink: LogSink = console,
	) {}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	private enabled(level: Exclude<LogLevel, "silent">): boolean {
		return RANK[this.level] >= RANK[level];
	}

	error(...args: unknown[]): void {
		if (this.enabled("error")) this.sink.error(this.prefix, ...args);
	}

	warn(...args: unknown[]): void {
		if (this.enabled("warn")) this.sink.warn(this.prefix, ...args);
	}

	info(...args: unknown[]): void {
		if (this.enabled("info")) this.sink.log(this.prefix, ...args);
	}

	debug(...args: unknown[]): void {
		if (this.enabled("debug")) this.sink.log(this.prefix, ...args);
	}
}
