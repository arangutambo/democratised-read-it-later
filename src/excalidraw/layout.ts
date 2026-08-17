/**
 * Where clips go on the drawing surface.
 *
 * A single column with room to work under each one, which is the shape the existing MATH7501
 * drawings already have: a page, then the working beneath it, then the next page. The clips
 * are locked so a pen stroke cannot drag the question sideways mid-solution — the standing
 * annoyance of writing over an imported page.
 *
 * Pure, so the arithmetic is checkable without a drawing. Excalidraw supplies the natural
 * size of each image at runtime; everything else is decided here.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

export interface Placed {
	/** Top-left of the image itself. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** The frame around the image and its working room. */
	frame: { x: number; y: number; width: number; height: number };
}

export interface LayoutOptions {
	/** Where the column starts. Below anything already on the drawing. */
	startY: number;
	x?: number;
	/** Blank space under each clip, as a fraction of its height. */
	workingRoom?: number;
	/** Padding between the image and its frame. */
	padding?: number;
	/** Vertical gap between one frame and the next. */
	gap?: number;
	/** Widest a clip may be drawn. Keeps a landscape slide from dwarfing a cropped figure. */
	maxWidth?: number;
}

const DEFAULTS = {
	x: 0,
	/**
	 * Two thirds of the clip's own height, and never less than a comfortable hand's worth.
	 *
	 * Proportional rather than fixed because the room a clip needs scales with it: a whole
	 * exam page needs more working under it than a one-line definition.
	 */
	workingRoom: 0.66,
	minRoom: 200,
	padding: 20,
	gap: 80,
	maxWidth: 1200,
};

/**
 * Stack clips down the page.
 *
 * `sizes` are the natural dimensions Excalidraw reports for each image. Anything wider than
 * `maxWidth` is scaled down proportionally rather than cropped.
 */
export function stack(
	sizes: readonly { width: number; height: number }[],
	options: LayoutOptions,
): Placed[] {
	const x = options.x ?? DEFAULTS.x;
	const room = options.workingRoom ?? DEFAULTS.workingRoom;
	const padding = options.padding ?? DEFAULTS.padding;
	const gap = options.gap ?? DEFAULTS.gap;
	const maxWidth = options.maxWidth ?? DEFAULTS.maxWidth;

	const out: Placed[] = [];
	let y = options.startY;

	for (const size of sizes) {
		const scale = size.width > maxWidth && size.width > 0 ? maxWidth / size.width : 1;
		const width = Math.max(1, Math.round(size.width * scale));
		const height = Math.max(1, Math.round(size.height * scale));

		const working = Math.max(DEFAULTS.minRoom, Math.round(height * room));

		out.push({
			x,
			y,
			width,
			height,
			frame: {
				x: x - padding,
				y: y - padding,
				width: width + padding * 2,
				height: height + working + padding * 2,
			},
		});

		y += height + working + padding * 2 + gap;
	}

	return out;
}

/**
 * The lowest point anything already on the drawing reaches.
 *
 * Sending again appends below existing work rather than on top of it — a semester's drawing
 * grows downwards, and a second send must not land on strokes already there.
 */
export function bottomOf(elements: readonly { y?: number; height?: number }[]): number {
	let bottom = 0;
	for (const element of elements) {
		const y = typeof element.y === "number" ? element.y : 0;
		const height = typeof element.height === "number" ? element.height : 0;
		bottom = Math.max(bottom, y + height);
	}
	return bottom;
}
