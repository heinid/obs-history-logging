import { WorkspaceLeaf } from "obsidian";
import type HistoryLoggingPlugin from "./main";

// A quiz modal that can be hidden while the user visits an entity page tab
// and brought back later with fresh data (stack order, reveal state and
// scroll positions are preserved because the DOM is only hidden, not torn
// down).
export interface StashableModal {
	containerEl: HTMLElement;
	onStashRestore(): void | Promise<void>;
}

// Hides the open quiz modal stack when jumping from a modal to an entity
// page, and restores it (data refreshed) once the tab the jump started
// from becomes active again.
export class ModalStash {
	private open: StashableModal[] = [];
	private stashed: StashableModal[] | null = null;
	private homeLeaf: WorkspaceLeaf | null = null;

	constructor(private plugin: HistoryLoggingPlugin) {
		plugin.registerEvent(
			plugin.app.workspace.on("active-leaf-change", (leaf) => {
				if (this.stashed && leaf && leaf === this.homeLeaf)
					this.restore();
			})
		);
	}

	track(modal: StashableModal): void {
		if (!this.open.includes(modal)) this.open.push(modal);
	}

	hasOpen(): boolean {
		return this.open.length > 0;
	}

	untrack(modal: StashableModal): void {
		this.open = this.open.filter((m) => m !== modal);
		if (this.stashed) {
			this.stashed = this.stashed.filter((m) => m !== modal);
			if (!this.stashed.length) {
				this.stashed = null;
				this.homeLeaf = null;
			}
		}
	}

	// Refresh every open (visible) quiz modal, e.g. after an entity edit.
	refreshOpen(): void {
		for (const modal of this.open)
			if (!this.stashed?.includes(modal)) void modal.onStashRestore();
	}

	// Hide the current modal stack (if any) and run the jump.
	jump(openPage: () => Promise<void>): void {
		if (this.open.length && !this.stashed) {
			this.homeLeaf = this.plugin.app.workspace.getMostRecentLeaf();
			this.stashed = [...this.open];
			for (const modal of this.stashed) modal.containerEl.hide();
		}
		void openPage();
	}

	private restore(): void {
		const modals = this.stashed ?? [];
		this.stashed = null;
		this.homeLeaf = null;
		for (const modal of modals) {
			modal.containerEl.show();
			void modal.onStashRestore();
		}
	}
}
