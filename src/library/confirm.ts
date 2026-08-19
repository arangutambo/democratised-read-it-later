/**
 * Asking before something cannot be undone by pressing a key.
 *
 * Obsidian has no confirmation primitive, so this is a small one. Deliberately plain: the
 * destructive button is not the default, and the text says what will actually happen rather
 * than asking "are you sure".
 */

import { Modal, Setting, type App } from "obsidian";

export interface ConfirmOptions {
	title: string;
	body: string;
	/** The destructive button's label. */
	confirmText: string;
	onConfirm: () => void;
}

export class ConfirmModal extends Modal {
	private readonly options: ConfirmOptions;

	constructor(app: App, options: ConfirmOptions) {
		super(app);
		this.options = options;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: this.options.title });
		contentEl.createEl("p", { text: this.options.body });

		new Setting(contentEl)
			.addButton((button) =>
				// Cancel first and focused, so a stray Return does nothing.
				button
					.setButtonText("Cancel")
					.setCta()
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(this.options.confirmText)
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.close();
						this.options.onConfirm();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
