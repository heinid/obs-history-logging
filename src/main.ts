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
import { ERA_MANAGER_VIEW_TYPE, EraManagerView } from "./era-manager-view";

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
		this.registerView(
			ERA_MANAGER_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new EraManagerView(leaf, this)
		);
		this.addRibbonIcon("history", "Open history timeline", () =>
			this.activateTimeline("tab")
		);

		this.addCommand({
			id: "add-event-at-cursor",
			name: "Add event to year tag under cursor",
			editorCallback: (editor: Editor) => addEventAtCursor(this, editor),
		});
		this.addCommand({
			id: "open-timeline",
			name: "Open history timeline",
			callback: () => this.activateTimeline("tab"),
		});
		this.addCommand({
			id: "open-timeline-new-pane",
			name: "Open another timeline (split pane)",
			callback: () => void this.openTimelineSplit(),
		});
		this.addCommand({
			id: "open-timeline-sidebar",
			name: "Open history timeline in sidebar",
			callback: () => this.activateTimeline("sidebar"),
		});
		this.addCommand({
			id: "manage-era-systems",
			name: "Manage era systems",
			callback: () => void this.openEraManager(),
		});
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(TIMELINE_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(ERA_MANAGER_VIEW_TYPE);
	}

	// Open the timeline either as a full main-pane tab (default) or a narrow
	// sidebar quick-peek. Reuses an existing leaf of the same kind if present.
	async activateTimeline(where: "tab" | "sidebar" = "tab"): Promise<void> {
		const { workspace } = this.app;
		const wantSidebar = where === "sidebar";
		const existing = workspace
			.getLeavesOfType(TIMELINE_VIEW_TYPE)
			.find((l) => (l.getRoot() === workspace.rightSplit) === wantSidebar);
		if (existing) {
			workspace.revealLeaf(existing);
			return;
		}
		const leaf = wantSidebar
			? workspace.getRightLeaf(false)
			: workspace.getLeaf("tab");
		if (!leaf) return;
		await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	// Always open a fresh timeline pane in a vertical split — each pane keeps
	// its own profile/query/era-system, so parallel comparison is just several
	// panes side by side (optionally year-linked via each pane's sync toggle).
	async openTimelineSplit(): Promise<void> {
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	// Year-aligned scroll sync: a synced pane reports its topmost visible year;
	// every other synced pane scrolls to that year.
	broadcastYear(source: TimelineView, key: number): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TimelineView && view !== source)
				view.alignToYear(key);
		}
	}

	// Open the era-system manager as a main-pane tab (reuse if already open).
	async openEraManager(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(ERA_MANAGER_VIEW_TYPE)[0];
		if (existing) {
			workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: ERA_MANAGER_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	// Rescan every open timeline so era-system edits show up immediately.
	async refreshTimelines(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TimelineView) await view.refresh();
		}
	}

	openSummary(id: string, tag: string, onSaved?: () => void): void {
		new SummaryModal(this.app, this, id, tag, onSaved).open();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
