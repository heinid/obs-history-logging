import { Editor, MarkdownFileInfo, MarkdownView, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	HistoryLoggingSettings,
	HistoryLoggingSettingTab,
} from "./settings";
import { DataStore } from "./data-store";
import { createLivePreviewExtension } from "./live-preview";
import { createReadingProcessor } from "./reading-view";
import { addEventAtCursor } from "./commands";
import { SummaryModal } from "./summary-modal";

export default class HistoryLoggingPlugin extends Plugin {
	settings!: HistoryLoggingSettings;
	store!: DataStore;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new DataStore(this.app, () => this.settings.dataFolder);

		this.registerEditorExtension(createLivePreviewExtension(this));
		this.registerMarkdownPostProcessor(createReadingProcessor(this));
		this.addSettingTab(new HistoryLoggingSettingTab(this.app, this));

		this.addCommand({
			id: "add-event-at-cursor",
			name: "Add event to year tag under cursor",
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				if (ctx instanceof MarkdownView) addEventAtCursor(this, editor, ctx);
			},
		});
	}

	openSummary(id: string, tag: string, filePath?: string): void {
		new SummaryModal(this.app, this, id, tag, filePath).open();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
