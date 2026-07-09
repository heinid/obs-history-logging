import { App, Menu, Modal, Notice, Setting } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { jumpToEv } from "./jump";
import { EntityEntry, displayName } from "./db-format";
import { AliasHit, aliasAtCursor, makeDbMarker } from "./db-marker";
import { EntityModal, EntitySuggestModal } from "./entity-modal";
import { generateId } from "./id";

// View / edit the markdown summary for a single event, backed by events.md.
// The textarea is also the entity-annotation surface: select text and
// right-click to turn it into a `{db …}` marker, and typing a known entity
// name offers a Tab completion that confirms the occurrence.
export class SummaryModal extends Modal {
	private value = "";
	private entities: EntityEntry[] = [];
	private hint: AliasHit | null = null;

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
		this.entities = [...(await this.plugin.store.readEntities()).values()];
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

		const hintEl = contentEl.createDiv({ cls: "hl-db-hint" });
		hintEl.hide();
		const updateHint = (): void => {
			this.value = textarea.value;
			const before = textarea.value.slice(0, textarea.selectionStart);
			this.hint = aliasAtCursor(before, this.entities);
			if (!this.hint) {
				hintEl.hide();
				return;
			}
			hintEl.empty();
			hintEl.createSpan({ cls: "hl-db-hint-alias", text: this.hint.alias });
			hintEl.createSpan({
				text: ` → ${displayName(this.hint.entity)} (${this.hint.entity.type})`,
			});
			hintEl.createSpan({ cls: "hl-db-hint-key", text: "Tab to annotate" });
			hintEl.show();
		};
		textarea.addEventListener("input", updateHint);
		textarea.addEventListener("keydown", (e) => {
			if (e.key !== "Tab" || !this.hint) return;
			e.preventDefault();
			const end = textarea.selectionStart;
			const start = end - this.hint.alias.length;
			this.insertMarker(textarea, start, end, this.hint.entity);
			this.hint = null;
			hintEl.hide();
		});

		textarea.addEventListener("contextmenu", (e) => {
			let start = textarea.selectionStart;
			let end = textarea.selectionEnd;
			if (start === end) return;
			e.preventDefault();
			const raw = textarea.value.slice(start, end);
			start += raw.length - raw.trimStart().length;
			end -= raw.length - raw.trimEnd().length;
			const selected = raw.trim();
			if (!selected || /[{}\n]/.test(selected)) return;
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle(`Annotate "${selected}" as new entity…`)
					.setIcon("plus")
					.onClick(() => this.createEntity(textarea, start, end, selected))
			);
			menu.addItem((item) =>
				item
					.setTitle(`Link "${selected}" to existing entity…`)
					.setIcon("link")
					.onClick(() =>
						new EntitySuggestModal(this.app, this.entities, (entity) =>
							this.insertMarker(textarea, start, end, entity)
						).open()
					)
			);
			menu.showAtMouseEvent(e);
		});

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

	// Replace [start, end) of the textarea with the entity marker and restore
	// the cursor just after it.
	private insertMarker(
		textarea: HTMLTextAreaElement,
		start: number,
		end: number,
		entity: EntityEntry
	): void {
		const word = textarea.value.slice(start, end);
		const marker = makeDbMarker(entity.id, word);
		textarea.value =
			textarea.value.slice(0, start) + marker + textarea.value.slice(end);
		this.value = textarea.value;
		const pos = start + marker.length;
		textarea.focus();
		textarea.setSelectionRange(pos, pos);
	}

	private createEntity(
		textarea: HTMLTextAreaElement,
		start: number,
		end: number,
		word: string
	): void {
		const entity: EntityEntry = {
			id: generateId((id) => this.entities.some((e) => e.id === id)),
			type: "",
			labels: [{ lang: this.plugin.settings.defaultLabelLang, text: word }],
			readings: [],
			audios: [],
			tags: [],
			body: "",
		};
		new EntityModal(this.app, this.plugin, entity, true, (saved) => {
			this.entities.push(saved);
			this.insertMarker(textarea, start, end, saved);
		}).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
