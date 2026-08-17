/**
 * Choosing which clips go to the drawing.
 *
 * A picker rather than "send everything", because a workbook accumulates clips over weeks and
 * the drawing is for tonight's six questions. Image clips only: a quote is text you would type
 * around, not something to write over by hand.
 */

import { Modal, Setting, type App } from "obsidian";

import type { ParsedClip } from "../note/parse";

export interface PickableClip extends ParsedClip {
	/** Page the clip came from, for the label. Undefined when `.reader` has lost it. */
	page?: number;
}

export class ClipPicker extends Modal {
	private readonly clips: PickableClip[];
	private readonly chosen = new Set<string>();
	private readonly onSubmit: (assets: string[], labels: string[]) => void;

	constructor(app: App, clips: PickableClip[], onSubmit: (assets: string[], labels: string[]) => void) {
		super(app);
		this.clips = clips;
		this.onSubmit = onSubmit;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Send clips to Excalidraw" });

		if (this.clips.length === 0) {
			contentEl.createEl("p", {
				text: "This note has no image clips yet. Press r to drag a box around something, or p for a whole page.",
			});
			return;
		}

		contentEl.createEl("p", {
			cls: "reader-setting-note",
			text: "They arrive locked, each in its own frame, stacked in a column with room to work underneath.",
		});

		const list = contentEl.createDiv({ cls: "reader-clip-list" });

		for (const clip of this.clips) {
			const row = new Setting(list)
				.setName(clip.page !== undefined ? `Page ${clip.page}` : clip.label)
				.setDesc(clip.label);

			row.addToggle((toggle) =>
				toggle.setValue(false).onChange((on) => {
					if (on) this.chosen.add(clip.id);
					else this.chosen.delete(clip.id);
				}),
			);
		}

		new Setting(contentEl)
			.addExtraButton((button) =>
				button
					.setIcon("check-check")
					.setTooltip("Select all")
					.onClick(() => {
						for (const clip of this.clips) this.chosen.add(clip.id);
						// Rebuild so the toggles reflect the change.
						this.onOpen();
						for (const clip of this.clips) this.chosen.add(clip.id);
					}),
			)
			.addButton((button) =>
				button
					.setButtonText("Send")
					.setCta()
					.onClick(() => {
						const picked = this.clips.filter((c) => this.chosen.has(c.id));
						this.close();
						this.onSubmit(
							picked.map((c) => c.assetPath ?? ""),
							picked.map((c) => (c.page !== undefined ? `Page ${c.page}` : "")),
						);
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
