/**
 * Pasting a YouTube link and getting a readable document back.
 *
 * The fetch happens in a hidden webview on a real youtube.com page, because that is the only
 * place the caption request is answered — see `obsidian-youtube-transcript`. It takes a couple
 * of seconds and it reaches the network, so it happens only when asked for, and the progress is
 * shown rather than left to guesswork.
 */

import { Modal, Notice, type App } from "obsidian";

import { videoIdFrom } from "./id";
import { writeTranscript, type FetchedTranscript, type SavedTranscript } from "./save";

export interface SaveVideoOptions {
	/** Where the transcript document is written. */
	documentsFolder: string;
	/** Called with the saved path and the canonical URL, to pair it and open it. */
	onSaved: (saved: SavedTranscript, url: string) => void;
}

/** What the stages coming out of the library mean to a person watching. */
const PROGRESS: Record<string, string> = {
	loading: "Opening YouTube…",
	"reading-page": "Asking for the captions…",
	"expanding-description": "Opening the transcript…",
	"opening-panel": "Opening the transcript…",
	collecting: "Reading the transcript…",
	done: "Writing it into your vault…",
};

export class SaveVideoModal extends Modal {
	private readonly options: SaveVideoOptions;
	private url = "";
	private busy = false;

	constructor(app: App, options: SaveVideoOptions) {
		super(app);
		this.options = options;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Save a YouTube video to Reader" });
		contentEl.createEl("p", {
			cls: "reader-setting-note",
			text:
				"Fetches the transcript once and writes it into your vault, so the words are yours " +
				"to search and quote. The video still plays from YouTube.",
		});

		const status = contentEl.createDiv({ cls: "reader-import-summary" });
		status.setText("Paste a video link.");

		const input = contentEl.createEl("input", { type: "url", cls: "reader-url-input" });
		input.placeholder = "https://www.youtube.com/watch?v=…";
		input.setAttribute("aria-label", "YouTube video address");

		const save = async (): Promise<void> => {
			if (this.busy) return;

			const videoId = videoIdFrom(this.url);
			if (!videoId) {
				status.setText("That does not look like a YouTube video link.");
				return;
			}

			this.busy = true;
			status.setText("Opening YouTube…");

			try {
				// Imported here rather than at the top: it touches `document` to make a webview,
				// and nothing should pay for that until someone actually asks for a transcript.
				const { fetchTranscript, isTranscriptError } = await import("obsidian-youtube-transcript");

				let transcript: FetchedTranscript;
				try {
					transcript = (await fetchTranscript(videoId, {
						// One persistent session, so a consent answer is given once rather than
						// on every video.
						partition: "persist:reader-youtube",
						onProgress: (stage: string) => status.setText(PROGRESS[stage] ?? "Working…"),
					})) as FetchedTranscript;
				} catch (error) {
					this.busy = false;
					status.setText(
						isTranscriptError(error) ? error.message : "That transcript could not be read.",
					);
					return;
				}

				const saved = await writeTranscript(
					this.app,
					transcript,
					`https://www.youtube.com/watch?v=${videoId}`,
					this.options.documentsFolder,
				);

				this.close();
				new Notice(`Reader: saved ${saved.title} — ${saved.cues} phrases`);
				this.options.onSaved(saved, `https://www.youtube.com/watch?v=${videoId}`);
			} catch (error) {
				this.busy = false;
				status.setText(error instanceof Error ? error.message : "That video could not be saved.");
			}
		};

		input.addEventListener("input", () => {
			this.url = input.value;
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void save();
			}
		});

		const buttons = contentEl.createDiv({ cls: "reader-modal-buttons" });
		const go = buttons.createEl("button", { text: "Save", cls: "mod-cta" });
		go.addEventListener("click", () => void save());
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

		window.setTimeout(() => input.focus(), 0);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
