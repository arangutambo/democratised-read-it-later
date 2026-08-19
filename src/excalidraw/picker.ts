/**
 * Choosing which clips go to the drawing.
 *
 * A gallery rather than a list, because the clips are pictures and a filename is not how you
 * recognise one. `p14-msx2s38l.png` tells you nothing; the figure it holds tells you
 * everything. Thumbnails come straight from the vault through `getResourcePath`, so nothing
 * is decoded or copied to show them.
 *
 * Image clips only: a quote is text you would type around, not something to write over.
 */

import { Modal, Setting, TFile, type App } from "obsidian";

import type { ParsedClip } from "../note/parse";

export interface PickableClip extends ParsedClip {
	/** Page the clip came from, for the caption. Undefined when `.reader` has lost it. */
	page?: number;
}

export class ClipPicker extends Modal {
	private readonly clips: PickableClip[];
	private readonly chosen = new Set<string>();
	private readonly onSubmit: (assets: string[], labels: string[]) => void;
	private countEl?: HTMLElement;

	constructor(app: App, clips: PickableClip[], onSubmit: (assets: string[], labels: string[]) => void) {
		super(app);
		this.clips = clips;
		this.onSubmit = onSubmit;
	}

	override onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("reader-picker-modal");

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

		const grid = contentEl.createDiv({ cls: "reader-clip-grid" });
		for (const clip of this.clips) this.renderCard(grid, clip);

		const footer = contentEl.createDiv({ cls: "reader-picker-footer" });
		this.countEl = footer.createDiv({ cls: "reader-picker-count" });

		new Setting(footer)
			.addExtraButton((button) =>
				button
					.setIcon("check-check")
					.setTooltip("Select all")
					.onClick(() => this.setAll(true)),
			)
			.addExtraButton((button) =>
				button
					.setIcon("x")
					.setTooltip("Select none")
					.onClick(() => this.setAll(false)),
			)
			.addButton((button) =>
				button
					.setButtonText("Send")
					.setCta()
					.onClick(() => this.submit()),
			);

		this.updateCount();
	}

	private renderCard(grid: HTMLElement, clip: PickableClip): void {
		const card = grid.createDiv({ cls: "reader-clip-card" });
		card.dataset.clip = clip.id;

		const thumb = card.createDiv({ cls: "reader-clip-thumb" });
		const file = clip.assetPath ? this.app.vault.getAbstractFileByPath(clip.assetPath) : null;

		if (file instanceof TFile) {
			// The vault's own resource URL: no decoding, no copy, and it honours the adapter.
			const img = thumb.createEl("img");
			img.src = this.app.vault.getResourcePath(file);
			img.alt = clip.label;
			// Lazily, because a workbook's note can hold dozens of these.
			img.loading = "lazy";
		} else {
			thumb.addClass("is-missing");
			thumb.setText("Missing");
		}

		const check = card.createDiv({ cls: "reader-clip-check" });
		const box = check.createEl("input", { type: "checkbox" });
		box.checked = this.chosen.has(clip.id);

		card.createDiv({
			cls: "reader-clip-caption",
			text: clip.page !== undefined ? `Page ${clip.page}` : clip.label,
		});

		const toggle = (on: boolean) => {
			if (on) this.chosen.add(clip.id);
			else this.chosen.delete(clip.id);
			box.checked = on;
			card.toggleClass("is-chosen", on);
			this.updateCount();
		};

		box.addEventListener("change", () => toggle(box.checked));
		// The whole card is the target: aiming at a 14px checkbox is not the gesture.
		card.addEventListener("click", (event) => {
			if (event.target === box) return;
			toggle(!this.chosen.has(clip.id));
		});
	}

	private setAll(on: boolean): void {
		for (const clip of this.clips) {
			if (on) this.chosen.add(clip.id);
			else this.chosen.delete(clip.id);
		}
		for (const card of Array.from(this.contentEl.querySelectorAll(".reader-clip-card"))) {
			const input = card.querySelector("input");
			if (input instanceof HTMLInputElement) input.checked = on;
			card.toggleClass("is-chosen", on);
		}
		this.updateCount();
	}

	private updateCount(): void {
		if (!this.countEl) return;
		const n = this.chosen.size;
		this.countEl.setText(n === 0 ? "Nothing selected" : `${n} of ${this.clips.length} selected`);
	}

	private submit(): void {
		// Note order, not click order: the drawing should read the way the document does.
		const picked = this.clips.filter((clip) => this.chosen.has(clip.id));
		this.close();
		this.onSubmit(
			picked.map((c) => c.assetPath ?? ""),
			picked.map((c) => (c.page !== undefined ? `Page ${c.page}` : "")),
		);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
