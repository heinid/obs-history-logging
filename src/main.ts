import { Editor, Plugin, WorkspaceLeaf } from "obsidian";
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
import { TIMELINE_VIEW_TYPE, TimelineView } from "./timeline-view";

export default class HistoryLoggingPlugin extends Plugin {
	settings!: HistoryLoggingSettings;
	store!: DataStore;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new DataStore(this.app, () => this.settings.dataFolder);

		this.registerEditorExtension(createLivePreviewExtension(this));
		this.registerMarkdownPostProcessor(createReadingProcessor(this));
		this.addSettingTab(new HistoryLoggingSettingTab(this.app, this));

		this.registerView(
			TIMELINE_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new TimelineView(leaf, this)
		);
		this.addRibbonIcon("history", "Open history timeline", () =>
			this.activateTimeline()
		);

		this.addCommand({
			id: "add-event-at-cursor",
			name: "Add event to year tag under cursor",
			editorCallback: (editor: Editor) => addEventAtCursor(this, editor),
		});
		this.addCommand({
			id: "open-timeline",
			name: "Open history timeline",
			callback: () => this.activateTimeline(),
		});
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(TIMELINE_VIEW_TYPE);
	}

	async activateTimeline(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(TIMELINE_VIEW_TYPE);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	openSummary(id: string, tag: string): void {
		new SummaryModal(this.app, this, id, tag).open();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
