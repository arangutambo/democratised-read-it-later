import { describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { TFile } from "../stubs/obsidian";

import {
	drawingPathFor,
	findExcalidraw,
	sendToExcalidraw,
	type ExcalidrawAutomate,
} from "../../src/excalidraw/handoff";

/**
 * A fake `ExcalidrawAutomate` that records what it was asked to do.
 *
 * Injected rather than mocked at the module level, because the value of this test is the
 * *sequence*: images added, sized, locked, framed, and only then committed to the view. Every
 * method name here was checked against the installed v2.25.3 bundle.
 */
class FakeEa implements ExcalidrawAutomate {
	elements = new Map<string, Record<string, unknown>>();
	frames: { x: number; y: number; width: number; height: number; name?: string }[] = [];
	viewElements: { y?: number; height?: number }[] = [];
	calls: string[] = [];
	created?: { filename?: string; foldername?: string };
	private next = 0;

	reset(): void {
		this.calls.push("reset");
	}
	setView(): unknown {
		this.calls.push("setView");
		return undefined;
	}
	getViewElements(): { y?: number; height?: number }[] {
		return this.viewElements;
	}
	async addImage(topX: number, topY: number, file: TFile | string): Promise<string> {
		const id = `el-${this.next++}`;
		// Excalidraw reports the image's natural size once it is added.
		this.elements.set(id, { x: topX, y: topY, width: 800, height: 1130, file });
		this.calls.push("addImage");
		return id;
	}
	addFrame(x: number, y: number, width: number, height: number, name?: string): string {
		this.frames.push({ x, y, width, height, name });
		this.calls.push("addFrame");
		return `frame-${this.next++}`;
	}
	getElement(id: string): Record<string, unknown> | undefined {
		return this.elements.get(id);
	}
	async addElementsToView(): Promise<unknown> {
		this.calls.push("addElementsToView");
		return undefined;
	}
	async create(params?: { filename?: string; foldername?: string }): Promise<unknown> {
		this.created = params;
		this.calls.push("create");
		return undefined;
	}
}

function fakeApp(files: string[] = []): App {
	const present = new Set(files);
	return {
		vault: {
			getAbstractFileByPath: (path: string) =>
				present.has(path) ? Object.assign(new TFile(), { path }) : null,
		},
		workspace: {
			getLeaf: () => ({ openFile: async () => {} }),
		},
	} as unknown as App;
}

const ASSETS = ["Sources/_assets/w/p3-a.png", "Sources/_assets/w/p7-b.png"];

describe("findExcalidraw", () => {
	it("returns nothing when the plugin is absent", () => {
		expect(findExcalidraw({ plugins: { plugins: {} } } as unknown as App)).toBeUndefined();
	});

	it("returns nothing when the API has moved", () => {
		// Feature detection rather than a version check: a partial API would leave half a
		// drawing behind, so the command should simply not be offered.
		const partial = { plugins: { plugins: { "obsidian-excalidraw-plugin": { ea: { reset: () => {} } } } } };
		expect(findExcalidraw(partial as unknown as App)).toBeUndefined();
	});

	it("returns the API when everything it needs is there", () => {
		const ea = new FakeEa();
		const host = { plugins: { plugins: { "obsidian-excalidraw-plugin": { ea } } } };
		expect(findExcalidraw(host as unknown as App)).toBe(ea);
	});
});

describe("sendToExcalidraw", () => {
	it("creates the drawing on the first send", async () => {
		const ea = new FakeEa();
		const result = await sendToExcalidraw(fakeApp(ASSETS), {
			assets: ASSETS,
			drawingPath: "Sources/w (drawing).excalidraw.md",
			ea,
		});

		expect(result.created).toBe(true);
		expect(ea.created?.filename).toBe("w (drawing)");
		expect(ea.created?.foldername).toBe("Sources");
	});

	it("appends below existing work on a later send", async () => {
		/*
		 * A semester's drawing grows downwards. A second send landing on top of strokes
		 * already there would destroy the working it was meant to sit beneath.
		 */
		const ea = new FakeEa();
		ea.viewElements = [{ y: 0, height: 900 }, { y: 2000, height: 1500 }];

		await sendToExcalidraw(fakeApp([...ASSETS, "Sources/w (drawing).excalidraw.md"]), {
			assets: ASSETS,
			drawingPath: "Sources/w (drawing).excalidraw.md",
			ea,
		});

		const tops = [...ea.elements.values()].map((el) => Number(el.y));
		expect(Math.min(...tops)).toBeGreaterThan(3500);
	});

	it("locks every clip so drawing cannot drag it", async () => {
		// The standing annoyance of writing over an imported page, and the main reason this
		// beats dragging one in by hand.
		const ea = new FakeEa();
		await sendToExcalidraw(fakeApp(ASSETS), {
			assets: ASSETS,
			drawingPath: "d.excalidraw.md",
			ea,
		});

		for (const element of ea.elements.values()) expect(element.locked).toBe(true);
	});

	it("gives each clip its own frame", async () => {
		const ea = new FakeEa();
		await sendToExcalidraw(fakeApp(ASSETS), {
			assets: ASSETS,
			labels: ["Page 3", "Page 7"],
			drawingPath: "d.excalidraw.md",
			ea,
		});

		expect(ea.frames).toHaveLength(2);
		expect(ea.frames.map((f) => f.name)).toEqual(["Page 3", "Page 7"]);
	});

	it("stacks them in a column, in the order given", async () => {
		const ea = new FakeEa();
		await sendToExcalidraw(fakeApp(ASSETS), {
			assets: ASSETS,
			drawingPath: "d.excalidraw.md",
			ea,
		});

		const tops = [...ea.elements.values()].map((el) => Number(el.y));
		expect(tops[0]).toBeLessThan(tops[1]);
	});

	it("commits to the view once, at the end", async () => {
		const ea = new FakeEa();
		await sendToExcalidraw(fakeApp(ASSETS), { assets: ASSETS, drawingPath: "d.excalidraw.md", ea });

		expect(ea.calls.filter((c) => c === "addElementsToView")).toHaveLength(1);
		expect(ea.calls[ea.calls.length - 1]).toBe("addElementsToView");
	});

	it("skips a clip whose file has gone missing", async () => {
		const ea = new FakeEa();
		const result = await sendToExcalidraw(fakeApp([ASSETS[0]]), {
			assets: ASSETS,
			drawingPath: "d.excalidraw.md",
			ea,
		});

		expect(result.sent).toBe(1);
	});

	it("refuses when none of the clips can be found", async () => {
		const ea = new FakeEa();
		await expect(
			sendToExcalidraw(fakeApp([]), { assets: ASSETS, drawingPath: "d.excalidraw.md", ea }),
		).rejects.toThrow(/None of those clips could be found/);
	});

	it("refuses when nothing was chosen", async () => {
		const ea = new FakeEa();
		await expect(
			sendToExcalidraw(fakeApp(ASSETS), { assets: [], drawingPath: "d.excalidraw.md", ea }),
		).rejects.toThrow(/No clips/);
	});
});

describe("drawingPathFor", () => {
	it("puts the drawing beside its note", () => {
		expect(drawingPathFor("Sources/Workbook 2026.md")).toBe(
			"Sources/Workbook 2026 (drawing).excalidraw.md",
		);
	});
});
