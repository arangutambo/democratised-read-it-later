/**
 * Teardown registry.
 *
 * This vault has a documented history of blank screens and 100% CPU from plugin JS that
 * kept running after unload, so every listener, observer, interval and iframe in this
 * plugin registers here and `onunload()` drains it. The registry exists rather than
 * relying solely on Obsidian's own `Component.register` because its internals are private
 * and cannot be asserted against — this one can, and `test/core/disposables.test.ts` does.
 *
 * Deliberately free of any `obsidian` import so it is unit-testable in plain Node.
 */

export type Disposer = () => void;

export interface DisposalError {
	name: string;
	error: unknown;
}

export class Disposables {
	private entries = new Map<number, { name: string; dispose: Disposer }>();
	private nextId = 1;
	private isDisposed = false;

	/**
	 * Register a teardown callback. Returns a handle that releases it early — use that when
	 * something is torn down during the plugin's life (a closed view) rather than at unload.
	 *
	 * Registering after disposal runs the disposer immediately instead of storing it. That
	 * is not a defensive nicety: Obsidian can unload a plugin while an `async onload()` is
	 * still awaiting, and without this the work started before the await leaks.
	 */
	add(name: string, dispose: Disposer): Disposer {
		if (this.isDisposed) {
			dispose();
			return () => {};
		}
		const id = this.nextId++;
		this.entries.set(id, { name, dispose });
		return () => this.release(id);
	}

	private release(id: number): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		entry.dispose();
	}

	/**
	 * Run every disposer in reverse registration order, so teardown mirrors setup.
	 *
	 * A throwing disposer must not strand the ones after it — that is precisely how a single
	 * bad teardown leaks every remaining listener. Errors are collected and returned for the
	 * caller to log.
	 */
	dispose(): DisposalError[] {
		if (this.isDisposed) return [];
		this.isDisposed = true;

		const errors: DisposalError[] = [];
		const ordered = [...this.entries.entries()].sort((a, b) => b[0] - a[0]);
		this.entries.clear();

		for (const [, entry] of ordered) {
			try {
				entry.dispose();
			} catch (error) {
				errors.push({ name: entry.name, error });
			}
		}
		return errors;
	}

	get size(): number {
		return this.entries.size;
	}

	get disposed(): boolean {
		return this.isDisposed;
	}

	/** Diagnostics only — what is still registered, for leak-hunting. */
	names(): string[] {
		return [...this.entries.values()].map((e) => e.name);
	}
}
