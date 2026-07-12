import { ItemView, WorkspaceLeaf } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { displayName } from "./db-format";
import { renderEntityPage } from "./entity-page";

export const ENTITY_VIEW_TYPE = "history-logging-entity";

// A full tab page for one entity. The actual rendering is shared with the
// admin backstage (see entity-page.ts); this wrapper only supplies the leaf.
export class EntityView extends ItemView {
	private entityId = "";
	private title = "Entity";

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ENTITY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.title;
	}

	getIcon(): string {
		return "book-open";
	}

	getState(): Record<string, unknown> {
		return { entityId: this.entityId };
	}

	async setState(
		state: unknown,
		result: { history: boolean }
	): Promise<void> {
		const s = state as { entityId?: string } | null;
		if (s?.entityId) {
			this.entityId = s.entityId;
			await this.refresh();
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.entityId) return;
		const entity = (await this.plugin.store.readEntities()).get(
			this.entityId
		);
		this.title = entity ? displayName(entity) : "Entity";
		await renderEntityPage(this.contentEl, this.entityId, {
			plugin: this.plugin,
			component: this,
			refresh: () => void this.refresh(),
		});
	}
}
