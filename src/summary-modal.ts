import { App, Modal, Notice, Setting } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { jumpToEv } from "./jump";

// View / edit the markdown summary for a single event, backed by events.md.
export class SummaryModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private id: string,
		private tag: string,
		private onSaved?: () => void
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const existing = await this.plugin.store.getEvent(this.id);
		this.value = existing?.summary ?? "";
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hl-summary-modal");

		contentEl.createEl("h3", { text: `Event ${this.tag}` });

		const textarea = contentEl.createEl("textarea", {
			cls: "hl-summary-textarea",
		});
		textarea.value = this.value;
		textarea.rows = 10;
		textarea.placeholder = "Write your summary / narrative for this date…";
		textarea.addEventListener("input", () => (this.value = textarea.value));

		const controls = new Setting(contentEl);
		controls.addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					await this.plugin.store.upsertEvent({
						id: this.id,
						tag: this.tag,
						summary: this.value,
					});
					new Notice("Summary saved");
					this.onSaved?.();
					this.close();
				})
		);
		controls.addButton((b) =>
			b.setButtonText("Jump to source").onClick(async () => {
				const ok = await jumpToEv(this.app, this.id);
				if (!ok) new Notice("Could not locate this event in the vault");
				else this.close();
			})
		);
		controls.addButton((b) =>
			b.setButtonText("Cancel").onClick(() => this.close())
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
