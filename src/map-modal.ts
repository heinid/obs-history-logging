// Create / edit a historical map entry (maps.md): image preview, title,
// time range, linked events and entities, and a free markdown annotation.

import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Setting,
	TFile,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { MapEntry } from "./maps-format";
import { generateId } from "./id";
import { displayName } from "./db-format";
import { EntitySuggestModal } from "./entity-modal";

export class MapModal extends Modal {
	private entry: MapEntry;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		entry: MapEntry,
		private isNew: boolean,
		private onSaved?: (m: MapEntry) => void
	) {
		super(app);
		this.entry = JSON.parse(JSON.stringify(entry)) as MapEntry;
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	private imageFile(): TFile | null {
		if (!this.entry.image) return null;
		return this.app.metadataCache.getFirstLinkpathDest(
			this.entry.image,
			""
		);
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hl-map-modal");

		contentEl.createDiv({
			cls: "hl-modal-head hl-map-modal-head",
			text: this.isNew ? "联入历史地图" : "编辑地图",
		});

		// Image preview.
		const preview = contentEl.createDiv({ cls: "hl-map-preview" });
		const file = this.imageFile();
		if (file) {
			const img = preview.createEl("img");
			img.src = this.app.vault.getResourcePath(file);
		} else {
			preview.createDiv({
				cls: "hl-map-preview-empty",
				text: this.entry.image
					? `找不到图片：${this.entry.image}`
					: "未选择图片",
			});
		}
		const pick = preview.createEl("button", {
			cls: "hl-modal-foot-btn hl-map-pick-btn",
			text: this.entry.image ? "更换图片…" : "选择图片…",
		});
		pick.addEventListener("click", () => {
			new ImageSuggestModal(this.app, (f) => {
				this.entry.image = f.path;
				if (!this.entry.title)
					this.entry.title = f.basename;
				void this.render();
			}).open();
		});

		new Setting(contentEl).setName("标题").addText((t) => {
			t.setValue(this.entry.title).onChange(
				(v) => (this.entry.title = v)
			);
			t.inputEl.addClass("hl-map-input");
		});

		new Setting(contentEl)
			.setName("时间范围")
			.setDesc("年代 tag 或自由文本，可留空")
			.addText((t) => {
				t.setValue(this.entry.range).onChange(
					(v) => (this.entry.range = v)
				);
				t.inputEl.addClass("hl-map-input");
			});

		// Linked events (read-only chips; linking happens from the ⌛ menu).
		if (this.entry.events.length) {
			const row = contentEl.createDiv({ cls: "hl-map-links" });
			row.createSpan({ cls: "hl-map-links-label", text: "事件" });
			const events = await this.plugin.store.readEvents();
			for (const evId of this.entry.events) {
				const chip = row.createSpan({ cls: "hl-map-chip" });
				chip.createSpan({
					text: events.get(evId)?.tag || evId,
				});
				const x = chip.createSpan({
					cls: "hl-map-chip-x",
					text: "×",
				});
				x.addEventListener("click", () => {
					this.entry.events = this.entry.events.filter(
						(e) => e !== evId
					);
					void this.render();
				});
			}
		}

		// Linked entities.
		const entRow = contentEl.createDiv({ cls: "hl-map-links" });
		entRow.createSpan({ cls: "hl-map-links-label", text: "词条" });
		const entities = await this.plugin.store.readEntities();
		for (const entId of this.entry.entities) {
			const chip = entRow.createSpan({ cls: "hl-map-chip" });
			const ent = entities.get(entId);
			chip.createSpan({ text: ent ? displayName(ent) : entId });
			const x = chip.createSpan({ cls: "hl-map-chip-x", text: "×" });
			x.addEventListener("click", () => {
				this.entry.entities = this.entry.entities.filter(
					(e) => e !== entId
				);
				void this.render();
			});
		}
		const add = entRow.createEl("button", {
			cls: "hl-map-chip-add",
			text: "＋",
		});
		add.setAttr("aria-label", "关联词条");
		add.addEventListener("click", () => {
			new EntitySuggestModal(
				this.app,
				[...entities.values()].filter(
					(e) => !this.entry.entities.includes(e.id)
				),
				(e) => {
					this.entry.entities.push(e.id);
					void this.render();
				}
			).open();
		});

		// Free annotation.
		const notes = contentEl.createEl("textarea", {
			cls: "hl-map-notes",
			attr: { placeholder: "注记（markdown，可留空）" },
		});
		notes.value = this.entry.body;
		notes.addEventListener("input", () => (this.entry.body = notes.value));

		const foot = contentEl.createDiv({ cls: "hl-modal-foot" });
		if (!this.isNew) {
			const del = foot.createEl("button", {
				cls: "hl-modal-foot-btn hl-map-delete",
				text: "删除",
			});
			del.addEventListener("click", () => {
				void (async () => {
					await this.plugin.store.removeMap(this.entry.id);
					new Notice("地图已删除");
					this.close();
					this.onSaved?.(this.entry);
				})();
			});
		}
		foot.createSpan({ cls: "hl-map-foot-space" });
		const save = foot.createEl("button", {
			cls: "hl-modal-foot-btn mod-cta",
			text: this.isNew ? "联入" : "保存",
		});
		save.addEventListener("click", () => {
			void (async () => {
				if (!this.entry.image) {
					new Notice("请先选择图片");
					return;
				}
				if (!this.entry.title.trim()) {
					const f = this.imageFile();
					this.entry.title = f?.basename ?? this.entry.image;
				}
				await this.plugin.store.upsertMap(this.entry);
				new Notice(this.isNew ? "地图已联入" : "地图已保存");
				this.close();
				this.onSaved?.(this.entry);
			})();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function newMapEntry(
	taken: (id: string) => boolean,
	partial: Partial<MapEntry> = {}
): MapEntry {
	return {
		id: generateId(taken),
		title: "",
		image: "",
		range: "",
		events: [],
		entities: [],
		body: "",
		...partial,
	};
}

// Fuzzy picker over every image file in the vault.
export class ImageSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder("选择图片…");
	}

	getItems(): TFile[] {
		const exts = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
		return this.app.vault
			.getFiles()
			.filter((f) => exts.has(f.extension.toLowerCase()));
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}
