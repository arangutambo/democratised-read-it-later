/**
 * Showing a transcription before it becomes a note.
 *
 * This modal is the rule the brief set: AI output is a suggestion you accept, never a silent
 * write. It is editable, because the fastest fix for a mis-read subscript is to correct it here
 * rather than hunt for it in the note later.
 */

import { Modal, Setting, type App } from "obsidian";

export class TranscriptionModal extends Modal {
	private text: string;
	private readonly onAccept: (text: string) => void;

	constructor(app: App, text: string, onAccept: (text: string) => void) {
		super(app);
		this.text = text;
		this.onAccept = onAccept;
	}

	override onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("reader-transcription-modal");

		contentEl.createEl("h3", { text: "Transcribed region" });
		contentEl.createEl("p", {
			cls: "reader-setting-note",
			text: "Check it before it goes in — models misread symbols. Edit anything that is wrong.",
		});

		const area = contentEl.createEl("textarea", { cls: "reader-transcription-text" });
		area.value = this.text;
		area.rows = 10;
		area.addEventListener("input", () => {
			this.text = area.value;
		});

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Discard").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Insert")
					.setCta()
					.onClick(() => {
						const text = this.text.trim();
						this.close();
						if (text !== "") this.onAccept(text);
					}),
			);

		window.setTimeout(() => area.focus(), 0);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
