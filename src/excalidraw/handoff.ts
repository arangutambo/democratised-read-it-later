/**
 * Sending clips to Excalidraw.
 *
 * Excalidraw is downstream of Reader, not a competitor to it: Reader selects, Excalidraw
 * draws. This closes the loop that the vault already shows being done by hand — 348 PDF page
 * embeds across 35 drawings, whole pages every time, because selecting the individual
 * questions was not possible.
 *
 * It also fixes the breakage that came with it. A drawing built this way embeds
 * `[[Sources/_assets/…/q3-a7f3.png]]`, a real file in the vault, rather than
 * `[[Workbook 2026.pdf#page=106]]` — and 174 of those 348 references now point at a PDF that
 * no longer exists anywhere on the machine.
 *
 * `ExcalidrawAutomate` is the plugin's public scripting API and the only third-party
 * interface in the whole design. Every call below was checked against the installed v2.25.3
 * bundle rather than recalled. It is reached through an injectable accessor so the layout can
 * be exercised without Excalidraw present, and feature-detected so its absence makes the
 * command disappear rather than fail.
 */

import { normalizePath, TFile, type App } from "obsidian";

import { bottomOf, stack } from "./layout";

export class ExcalidrawUnavailableError extends Error {}

/** The slice of `ExcalidrawAutomate` used here. Names verified against v2.25.3. */
export interface ExcalidrawAutomate {
	reset(): void;
	setView(view?: unknown): unknown;
	getViewElements(): { y?: number; height?: number }[];
	addImage(topX: number, topY: number, imageFile: TFile | string, scale?: boolean, anchor?: boolean): Promise<string>;
	addFrame(topX: number, topY: number, width: number, height: number, name?: string): string;
	getElement(id: string): Record<string, unknown> | undefined;
	addElementsToView(repositionToCursor?: boolean, save?: boolean, newElementsOnTop?: boolean): Promise<unknown>;
	create(params?: { filename?: string; foldername?: string; onNewPane?: boolean; silent?: boolean }): Promise<unknown>;
}

/** Obsidian's plugin registry, which the typings do not describe. */
interface PluginHost {
	plugins?: { plugins?: Record<string, { ea?: ExcalidrawAutomate } | undefined> };
}

/**
 * The installed Excalidraw's scripting API, or undefined when it is not available.
 *
 * Feature detection rather than a version check: the plugin may be absent, disabled, or a
 * build whose API has moved. Any of those means the command should not be offered.
 */
export function findExcalidraw(app: App): ExcalidrawAutomate | undefined {
	const host = (app as unknown as PluginHost).plugins?.plugins?.["obsidian-excalidraw-plugin"];
	const ea = host?.ea;
	if (!ea) return undefined;

	// Everything the handoff calls must exist, or a partial run leaves half a drawing.
	const required: (keyof ExcalidrawAutomate)[] = [
		"reset",
		"setView",
		"getViewElements",
		"addImage",
		"addFrame",
		"getElement",
		"addElementsToView",
		"create",
	];
	return required.every((name) => typeof ea[name] === "function") ? ea : undefined;
}

export interface HandoffOptions {
	/** Vault-relative paths of the images to send, in the order they should be stacked. */
	assets: readonly string[];
	/** Where the drawing lives. One per document, created on first send. */
	drawingPath: string;
	/** Label for each clip's frame — the page it came from reads well here. */
	labels?: readonly string[];
	/** Blank space under each clip, as a fraction of its height. */
	workingRoom?: number;
	ea: ExcalidrawAutomate;
}

export interface HandoffResult {
	drawingPath: string;
	sent: number;
	created: boolean;
}

/**
 * Put the chosen clips into the document's drawing, appending below whatever is there.
 *
 * The drawing has to be *open* for elements to be added: `addElementsToView` works against a
 * live view, and writing the `.excalidraw.md` format by hand would mean reimplementing
 * someone else's file format for no gain.
 */
export async function sendToExcalidraw(
	app: App,
	options: HandoffOptions,
): Promise<HandoffResult> {
	const { ea, assets, labels = [] } = options;
	if (assets.length === 0) throw new ExcalidrawUnavailableError("No clips were chosen.");

	const drawingPath = normalizePath(options.drawingPath);
	const existing = app.vault.getAbstractFileByPath(drawingPath);
	const created = !(existing instanceof TFile);

	ea.reset();

	if (created) {
		const slash = drawingPath.lastIndexOf("/");
		await ea.create({
			filename: drawingPath.slice(slash + 1).replace(/\.excalidraw\.md$/, ""),
			foldername: slash > 0 ? drawingPath.slice(0, slash) : undefined,
			onNewPane: true,
		});
	} else {
		await app.workspace.getLeaf(true).openFile(existing);
	}

	// "active" is the leaf just opened. Without a view attached, elements go nowhere.
	ea.setView("active");

	// Append below existing work: a semester's drawing grows downwards, and a second send
	// must not land on strokes already there.
	const startY = created ? 0 : bottomOf(ea.getViewElements()) + 120;

	/*
	 * Two passes. The first adds each image so Excalidraw can report its natural size; the
	 * second positions the frames from those sizes. Doing it in one pass would mean guessing
	 * each image's height before it exists, and the column would drift.
	 */
	const added: { id: string; width: number; height: number }[] = [];
	for (const asset of assets) {
		const file = app.vault.getAbstractFileByPath(normalizePath(asset));
		if (!(file instanceof TFile)) continue;

		const id = await ea.addImage(0, 0, file, false, false);
		const element = ea.getElement(id);
		added.push({
			id,
			width: Number(element?.width ?? 0) || 400,
			height: Number(element?.height ?? 0) || 300,
		});
	}

	if (added.length === 0) {
		throw new ExcalidrawUnavailableError("None of those clips could be found in the vault.");
	}

	const placed = stack(added, { startY, workingRoom: options.workingRoom });

	for (const [i, place] of placed.entries()) {
		const element = ea.getElement(added[i].id);
		if (!element) continue;

		element.x = place.x;
		element.y = place.y;
		element.width = place.width;
		element.height = place.height;
		// Locked, so drawing over the clip cannot drag it sideways. This is the whole reason
		// the handoff is better than dragging a page in by hand.
		element.locked = true;

		ea.addFrame(place.frame.x, place.frame.y, place.frame.width, place.frame.height, labels[i]);
	}

	// Do not reposition to the cursor — the column's own geometry is the point. Save, and put
	// new elements on top so they are not hidden behind existing strokes.
	await ea.addElementsToView(false, true, true);

	return { drawingPath, sent: added.length, created };
}

/** The drawing that belongs to a note: `<note> (drawing).excalidraw.md` beside it. */
export function drawingPathFor(notePath: string): string {
	const withoutExtension = notePath.replace(/\.md$/, "");
	return `${withoutExtension} (drawing).excalidraw.md`;
}
