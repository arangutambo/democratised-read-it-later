import { describe, expect, it, vi } from "vitest";

import { Disposables } from "../../src/core/disposables";

describe("Disposables", () => {
	it("runs every disposer and empties the registry", () => {
		const registry = new Disposables();
		const a = vi.fn();
		const b = vi.fn();

		registry.add("a", a);
		registry.add("b", b);
		expect(registry.size).toBe(2);

		const errors = registry.dispose();

		expect(errors).toEqual([]);
		expect(a).toHaveBeenCalledOnce();
		expect(b).toHaveBeenCalledOnce();
		expect(registry.size).toBe(0);
		expect(registry.disposed).toBe(true);
	});

	it("tears down in reverse registration order", () => {
		const registry = new Disposables();
		const order: string[] = [];

		registry.add("first", () => order.push("first"));
		registry.add("second", () => order.push("second"));
		registry.add("third", () => order.push("third"));

		registry.dispose();

		expect(order).toEqual(["third", "second", "first"]);
	});

	it("does not strand later disposers when one throws", () => {
		// The failure this guards against: one bad teardown leaking every listener after it.
		const registry = new Disposables();
		const survivor = vi.fn();

		registry.add("survivor", survivor);
		registry.add("thrower", () => {
			throw new Error("boom");
		});

		const errors = registry.dispose();

		expect(survivor).toHaveBeenCalledOnce();
		expect(errors).toHaveLength(1);
		expect(errors[0].name).toBe("thrower");
		expect((errors[0].error as Error).message).toBe("boom");
		expect(registry.size).toBe(0);
	});

	it("releases a single entry early without disturbing the rest", () => {
		const registry = new Disposables();
		const kept = vi.fn();
		const early = vi.fn();

		registry.add("kept", kept);
		const release = registry.add("early", early);

		release();
		expect(early).toHaveBeenCalledOnce();
		expect(registry.size).toBe(1);
		expect(registry.names()).toEqual(["kept"]);

		registry.dispose();
		expect(early).toHaveBeenCalledOnce();
		expect(kept).toHaveBeenCalledOnce();
	});

	it("is idempotent", () => {
		const registry = new Disposables();
		const fn = vi.fn();
		registry.add("once", fn);

		registry.dispose();
		registry.dispose();

		expect(fn).toHaveBeenCalledOnce();
	});

	it("disposes immediately when something registers after unload", () => {
		// Obsidian can unload a plugin while an async onload() is still awaiting. Without
		// this, work started before the await leaks past unload.
		const registry = new Disposables();
		registry.dispose();

		const late = vi.fn();
		registry.add("late", late);

		expect(late).toHaveBeenCalledOnce();
		expect(registry.size).toBe(0);
	});

	it("releasing twice runs the disposer only once", () => {
		const registry = new Disposables();
		const fn = vi.fn();
		const release = registry.add("x", fn);

		release();
		release();

		expect(fn).toHaveBeenCalledOnce();
	});
});
