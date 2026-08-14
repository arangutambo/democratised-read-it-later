/**
 * Which pages are allowed to exist as canvases at any moment.
 *
 * This is the memory budget, and it is a tested module rather than an emergent property of
 * the view because it is the difference between opening a 315-page workbook and wedging
 * Obsidian. A rendered page is a canvas: at a typical display size on a 2× screen that is
 * 10–15 MB each, so "render what you scroll past and let the browser sort it out" is roughly
 * four gigabytes by the end of the document.
 *
 * The window is deliberately small and centred on where you are, with a bias towards the
 * direction of travel — reading forwards should not have to wait for a render on every page.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

export interface WindowChange {
	/** Pages that should be rendered now, nearest to the current page first. */
	render: number[];
	/** Pages whose canvas should be released now. */
	release: number[];
}

export interface PageWindowOptions {
	total: number;
	/**
	 * Maximum pages held as canvases at once, including the current one.
	 *
	 * Three is the floor that still allows reading in either direction without a blank frame:
	 * the page you are on, and one each side.
	 */
	budget: number;
}

export class PageWindow {
	private readonly total: number;
	private readonly budget: number;
	private live = new Set<number>();
	private current = 1;
	/** +1 reading forwards, -1 backwards. Biases the window the way you are going. */
	private direction: 1 | -1 = 1;

	constructor({ total, budget }: PageWindowOptions) {
		this.total = Math.max(1, Math.floor(total));
		this.budget = Math.max(3, Math.floor(budget));
	}

	/** Pages currently held, in ascending order. Diagnostics and tests. */
	get held(): number[] {
		return [...this.live].sort((a, b) => a - b);
	}

	get size(): number {
		return this.live.size;
	}

	/**
	 * Move to a page and report what to render and what to release.
	 *
	 * Callers must apply `release` — this class only tracks intent. The view registers each
	 * canvas with the disposables registry, so a released page is genuinely freed rather than
	 * merely forgotten.
	 */
	update(page: number): WindowChange {
		const next = Math.min(this.total, Math.max(1, Math.floor(page)));
		if (next !== this.current) this.direction = next > this.current ? 1 : -1;
		this.current = next;

		const wanted = this.wanted();
		const render = wanted.filter((p) => !this.live.has(p));
		const release = [...this.live].filter((p) => !wanted.includes(p));

		for (const p of release) this.live.delete(p);
		for (const p of render) this.live.add(p);

		return { render, release: release.sort((a, b) => a - b) };
	}

	/** Everything goes — the document is closing, or the file changed underneath us. */
	clear(): WindowChange {
		const release = this.held;
		this.live.clear();
		return { render: [], release };
	}

	/**
	 * The pages that should be live, nearest first.
	 *
	 * Nearest-first ordering matters: the caller renders in this order, so the page you are
	 * actually looking at appears before its neighbours are worked on.
	 */
	private wanted(): number[] {
		const out = [this.current];

		// Walk outwards from the current page, taking the direction of travel first at each
		// distance, until the budget is met or the document runs out.
		for (let distance = 1; out.length < this.budget; distance++) {
			const ahead = this.current + distance * this.direction;
			const behind = this.current - distance * this.direction;

			const inRange = (p: number) => p >= 1 && p <= this.total;
			if (!inRange(ahead) && !inRange(behind)) break;

			if (inRange(ahead) && out.length < this.budget) out.push(ahead);
			if (inRange(behind) && out.length < this.budget) out.push(behind);
		}

		return out;
	}
}
