/**
 * A video as something you can point at.
 *
 * Unlike every other source, what you clip and what you read are two different objects: the
 * picture comes from the player, the words come from the transcript beside it. That is why the
 * layout stacks them — the video above, its transcript underneath — and why a frame and a
 * quote are captured by different keys.
 *
 * The unit is a transcript paragraph, so the outline and the position memory have something to
 * count. A frame is located by its moment rather than by a paragraph, because the whole point
 * of capturing one is that it is the picture at an instant.
 */

import type { NormalisedRect } from "../capture/types";
import type { DocumentSurfaces, SurfaceSize } from "../reader/surface/surface";
import { parseTranscript, type TranscriptParagraph } from "./transcript";

export class VideoSurface implements DocumentSurfaces {
	readonly kind = "video-frame" as const;

	/**
	 * A frame is captured from the player, not cropped out of a rendered surface, so "clip the
	 * whole surface" has no meaning here either. Key 3 says so rather than inventing one.
	 */
	readonly wholeSurfaceIsClippable = false;

	readonly videoId: string;
	private readonly paragraphs: TranscriptParagraph[];

	private constructor(videoId: string, paragraphs: TranscriptParagraph[]) {
		this.videoId = videoId;
		this.paragraphs = paragraphs;
	}

	/**
	 * Open a video whose transcript is already on disk.
	 *
	 * Deliberately not a fetch. Readwise's export carries 1,458 of these, and YouTube now gates
	 * its caption endpoint — so the local file is both the reliable source and the one that
	 * needs no network at all.
	 */
	static open(videoId: string, transcriptHtml: string): VideoSurface {
		const paragraphs = parseTranscript(transcriptHtml, (html) =>
			new DOMParser().parseFromString(html, "text/html"),
		);
		return new VideoSurface(videoId, paragraphs);
	}

	get count(): number {
		return Math.max(1, this.paragraphs.length);
	}

	get transcript(): readonly TranscriptParagraph[] {
		return this.paragraphs;
	}

	get hasTranscript(): boolean {
		return this.paragraphs.length > 0;
	}

	/** Seconds into the video at which a paragraph begins. */
	startOfParagraph(index: number): number {
		return this.paragraphs[this.clamp(index) - 1]?.start ?? 0;
	}

	/** A paragraph's text, for search and for a quote's surrounding context. */
	paragraphText(index: number): string {
		return this.paragraphs[this.clamp(index) - 1]?.text ?? "";
	}

	/**
	 * A transcript has no headings, so the outline is time.
	 *
	 * Every fourth paragraph, which at roughly 30 seconds each puts a mark every two minutes —
	 * enough to jump around an 18-minute video without turning the outline into a second copy
	 * of the transcript.
	 */
	outline(): { title: string; depth: number; page?: number }[] {
		return this.paragraphs
			.filter((_, i) => i % 4 === 0)
			.map((paragraph) => ({
				title: paragraph.text.slice(0, 60),
				depth: 0,
				page: paragraph.index,
			}));
	}

	/** Text reflows to the pane; nothing here is laid out by size. */
	async size(_index: number): Promise<SurfaceSize> {
		return { width: 1, height: 1 };
	}

	/**
	 * Not offered: a frame comes from the player, not from rasterising a surface.
	 *
	 * The view captures it through Electron's own compositor instead, which is the only way to
	 * get the picture out of a cross-origin player at all.
	 */
	async renderRegion(_index: number, _rect: NormalisedRect, _dpi: number): Promise<Uint8Array> {
		throw new Error("A video is not a page. Press f for the current frame, or q to quote the transcript.");
	}

	async close(): Promise<void> {
		// Parsed text only.
	}

	private clamp(index: number): number {
		return Math.min(this.count, Math.max(1, Math.floor(index)));
	}
}
