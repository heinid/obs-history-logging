import { App, EventRef, Modal, Notice, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { jumpToEv } from "./jump";
import { DbType, EntityEntry } from "./db-format";
import { EntityModal } from "./entity-modal";
import { LiveEditor, registerEscapeFirst } from "./live-editor";
import { generateId } from "./id";
import { describeYear, parseYearTag } from "./year-tag";

// View / edit the markdown summary for a single event, backed by events.md.
// A live CodeMirror editor renders `{db …}` markers folded and bold text
// bold, hosts the entity completion dropdown and the right-click annotation
// menu, and auto-saves on a debounce — there is no Save button.
export class SummaryModal extends Modal {
	private entities: EntityEntry[] = [];
	private types: DbType[] = [];
	private editor?: LiveEditor;
	private statusEl?: HTMLElement;
	private saveTimer: number | null = null;
	private dirty = false;
	private entitiesWatch?: EventRef;
	private ensured = false;

	// `ensure` defers event creation for a bare tag: it is run before the
	// first write (wrapping the tag in its source note), and nothing at all
	// is written while the summary is still empty.
	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private id: string,
		private tag: string,
		private onSaved?: (summary: string) => void,
		private ensure?: () => Promise<boolean>
	) {
		super(app);
		this.ensured = !ensure;
	}

	async onOpen(): Promise<void> {
		// Escape closes the completion dropdown / popover first; only a second
		// Escape (nothing open) closes the modal. Must run before the modal's
		// own Escape handler in the scope.
		registerEscapeFirst(this.scope, () =>
			this.editor?.closeSuggestIfOpen() ?? false
		);
		const existing = await this.plugin.store.getEvent(this.id);
		this.entities = [...(await this.plugin.store.readEntities()).values()];
		this.types = await this.plugin.store.readDbTypes();
		// Entities created or edited while this modal is open (from any entry
		// point) must show up in completion right away.
		this.entitiesWatch = this.app.vault.on("modify", (f) => {
			if (
				f instanceof TFile &&
				f.path === this.plugin.store.entitiesFilePath()
			)
				void this.reloadEntities();
		});
		this.render(existing?.summary ?? "");
	}

	private async reloadEntities(): Promise<void> {
		this.entities = [...(await this.plugin.store.readEntities()).values()];
		this.editor?.refreshDecorations();
	}

	private typeColor(name: string): string | null {
		return this.types.find((t) => t.name === name)?.color ?? null;
	}

	private colorFor(id: string): string | null {
		const e = this.entities.find((x) => x.id === id);
		return e ? this.typeColor(e.type) ?? "" : null;
	}

	private render(value: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hl-summary-modal");

		const head = contentEl.createDiv({ cls: "hl-modal-head" });
		const decoded = parseYearTag(this.tag);
		head.createSpan({
			cls: "hl-modal-year",
			text: decoded ? describeYear(decoded) : this.tag,
		});
		const pill = head.createSpan({ cls: "hl-modal-tag", text: this.tag });
		pill.addClass("hl-clickable");
		pill.setAttr("aria-label", "Show on timeline");
		pill.addEventListener("click", () => {
			this.close();
			void this.plugin.revealOnTimeline(this.id, this.tag);
		});

		const editorEl = contentEl.createDiv({ cls: "hl-summary-editor" });
		this.editor = new LiveEditor(editorEl, {
			value,
			placeholder: "Write your summary / narrative for this date…",
			onChange: () => this.scheduleSave(),
			colorFor: (id) => this.colorFor(id),
			onOpenEntity: (id) => this.editEntity(id),
			onOpenEntityPage: (id) => {
				this.close();
				void this.plugin.openEntityView(id);
			},
			annotate: {
				entities: () => this.entities,
				typeColor: (name) => this.typeColor(name),
				onCreate: (word, apply) => this.createEntity(word, apply),
				autoTrigger: () => this.plugin.settings.completeAutoTrigger,
				lastToken: () => this.plugin.settings.completeLastToken,
			},
		});

		const foot = contentEl.createDiv({ cls: "hl-modal-foot" });
		this.statusEl = foot.createSpan({ cls: "hl-modal-status" });
		const jump = foot.createEl("button", {
			cls: "hl-modal-foot-btn",
			text: "↗ Jump to source",
		});
		jump.addEventListener("click", async () => {
			const ok = await jumpToEv(this.app, this.id);
			if (!ok) new Notice("Could not locate this event in the vault");
			else this.close();
		});

		// Obsidian focuses the modal container right after onOpen; grab the
		// focus back once that has happened.
		window.setTimeout(() => this.editor?.focus(), 0);
	}

	private scheduleSave(): void {
		this.dirty = true;
		this.setStatus("typing");
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.save(), 600);
	}

	private async save(): Promise<void> {
		if (!this.dirty || !this.editor) return;
		const summary = this.editor.getValue();
		if (!this.ensured) {
			if (!summary.trim()) return;
			if (!(await this.ensure!())) return;
			this.ensured = true;
		}
		this.dirty = false;
		await this.plugin.store.upsertEvent({
			id: this.id,
			tag: this.tag,
			summary,
		});
		this.setStatus("saved");
		this.onSaved?.(this.editor.getValue());
	}

	private setStatus(state: "typing" | "saved"): void {
		if (!this.statusEl) return;
		this.statusEl.empty();
		this.statusEl.createSpan({
			cls: `hl-status-dot ${state === "saved" ? "is-saved" : "is-typing"}`,
		});
		this.statusEl.createSpan({
			text: state === "saved" ? "已自动保存" : "输入中…",
		});
	}

	// Left-click / "编辑词条": open the entity editor in place instead of
	// navigating away to the full tab page.
	private editEntity(id: string): void {
		const entity = this.entities.find((e) => e.id === id);
		if (!entity) {
			void this.plugin.openEntityView(id);
			return;
		}
		new EntityModal(this.app, this.plugin, entity, false, (saved) => {
			const i = this.entities.findIndex((e) => e.id === saved.id);
			if (i >= 0) this.entities[i] = saved;
			this.editor?.refreshDecorations();
		}).open();
	}

	private createEntity(word: string, apply: (e: EntityEntry) => void): void {
		const entity: EntityEntry = {
			id: generateId((id) => this.entities.some((e) => e.id === id)),
			type: "",
			labels: [
				{ lang: this.plugin.settings.entityLangs[0] ?? "zh", text: word },
			],
			readings: [],
			audios: [],
			tags: [],
			body: "",
		};
		new EntityModal(this.app, this.plugin, entity, true, (saved) => {
			this.entities.push(saved);
			apply(saved);
			this.editor?.refreshDecorations();
		}).open();
	}

	onClose(): void {
		if (this.entitiesWatch) this.app.vault.offref(this.entitiesWatch);
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		void this.save();
		this.editor?.destroy();
		this.contentEl.empty();
	}
}
