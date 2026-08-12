import { describe, expect, it, vi } from "vitest";

import { Logger, type LogSink } from "../../src/core/log";

function sink(): LogSink & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
	return { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
}

describe("Logger", () => {
	it("silences everything at level silent", () => {
		const s = sink();
		const log = new Logger("[x]", "silent", s);

		log.error("a");
		log.warn("b");
		log.info("c");
		log.debug("d");

		expect(s.error).not.toHaveBeenCalled();
		expect(s.warn).not.toHaveBeenCalled();
		expect(s.log).not.toHaveBeenCalled();
	});

	it("emits only at or above the configured level", () => {
		const s = sink();
		const log = new Logger("[x]", "warn", s);

		log.error("a");
		log.warn("b");
		log.info("c");
		log.debug("d");

		expect(s.error).toHaveBeenCalledOnce();
		expect(s.warn).toHaveBeenCalledOnce();
		expect(s.log).not.toHaveBeenCalled();
	});

	it("passes the prefix through ahead of the arguments", () => {
		const s = sink();
		new Logger("[reader]", "debug", s).debug("loaded", { n: 1 });
		expect(s.log).toHaveBeenCalledWith("[reader]", "loaded", { n: 1 });
	});

	it("respects a level changed at runtime", () => {
		const s = sink();
		const log = new Logger("[x]", "silent", s);

		log.error("ignored");
		expect(s.error).not.toHaveBeenCalled();

		log.setLevel("debug");
		log.error("heard");
		log.debug("also heard");

		expect(s.error).toHaveBeenCalledOnce();
		expect(s.log).toHaveBeenCalledOnce();
	});
});
