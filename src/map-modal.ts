// Create / edit a historical map entry (maps.md). The image is the hero:
// paste or drop a picture straight into the modal (it is saved into the
// vault via the attachment settings), or pick an existing vault image. The
// linked events render as rich rows — year, tag, summary/source preview and
// the full ⌛ menu — and entity chips open their entity pages.

import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	TFile,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { MapEntry } from "./maps-format";
import { generateId } from "./id";
import { displayName } from "./db-format";
import { EntitySuggestModal } from "./entity-modal";
import { eventPreview } from "./map-candidates";
import { openEvMenu } from "./ev-menu";
import { describeYear, parseYearTag } from "./year-tag";

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
		this.modalEl.addClass("hl-map-modal-window");
		this.contentEl.addEventListener("paste", (e) => {
			void this.handleImageTransfer(e.clipboardData, e);
		});
		this.contentEl.addEventListener("dragover", (e) =>
			e.preventDefault()
		);
		this.contentEl.addEventListener("drop", (e) => {
			void this.handleImageTransfer(e.dataTransfer, e);
		});
		await this.render();
	}

	private async handleImageTransfer(
		data: DataTransfer | null,
		e: Event
	): Promise<void> {
		const item = data
			? Array.from(data.items).find((i) => i.type.startsWith("image/"))
			: null;
		const blob = item?.getAsFile();
		if (!blob) return;
		e.preventDefault();
		e.stopPropagation();
		const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
		const stamp = new Date()
			.toISOString()
			.replace(/[-:TZ.]/g, "")
			.slice(0, 14);
		const name =
			blob.name && blob.name !== "image.png"
				? blob.name
				: `map-${stamp}.${ext}`;
		const path = await this.app.fileManager.getAvailablePathForAttachment(
			name
		);
		const file = await this.app.vault.createBinary(
			path,
			await blob.arrayBuffer()
		);
		this.entry.image = file.path;
		if (!this.entry.title) this.entry.title = file.basename;
		new Notice(`图片已存入：${file.path}`);
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

		// Image hero: preview when set, paste/drop zone when empty.
		const hero = contentEl.createDiv({ cls: "hl-map-hero" });
		const file = this.imageFile();
		if (file) {
			const img = hero.createEl("img", { cls: "hl-map-hero-img" });
			img.src = this.app.vault.getResourcePath(file);
			const bar = hero.createDiv({ cls: "hl-map-hero-bar" });
			bar.createSpan({ cls: "hl-map-hero-path", text: file.path });
			const swap = bar.createEl("button", {
				cls: "hl-map-hero-btn",
				text: "更换…",
			});
			swap.addEventListener("click", () => this.pickFromVault());
		} else {
			const zone = hero.createDiv({ cls: "hl-map-dropzone" });
			zone.createDiv({
				cls: "hl-map-dropzone-hint",
				text: this.entry.image
					? `找不到图片：${this.entry.image}`
					: "粘贴（Ctrl+V）或拖入图片",
			});
			const pick = zone.createEl("button", {
				cls: "hl-map-hero-btn",
				text: "从库中选择…",
			});
			pick.addEventListener("click", () => this.pickFromVault());
		}

		// Title.
		const titleRow = contentEl.createDiv({ cls: "hl-map-field" });
		titleRow.createSpan({ cls: "hl-map-field-label", text: "标题" });
		const title = titleRow.createEl("input", {
			cls: "hl-map-input",
			type: "text",
			attr: { placeholder: "地图标题" },
		});
		title.value = this.entry.title;
		title.addEventListener(
			"input",
			() => (this.entry.title = title.value)
		);

		// Linked events: rich rows with year, tag, preview and the ⌛ menu.
		contentEl.createDiv({ cls: "hl-overline", text: "事件" });
		const evBox = contentEl.createDiv({ cls: "hl-map-ev-list" });
		if (!this.entry.events.length)
			evBox.createDiv({
				cls: "hl-map-section-empty",
				text: "尚无关联事件——从笔记里的 ⌛ 菜单联入。",
			});
		const events = await this.plugin.store.readEvents();
		for (const evId of this.entry.events) {
			const tag = events.get(evId)?.tag ?? "";
			const row = evBox.createDiv({ cls: "hl-map-ev-row" });
			const decoded = tag ? parseYearTag(tag) : null;
			row.createSpan({
				cls: "hl-map-ev-year",
				text: decoded ? describeYear(decoded) : "？",
			});
			if (tag) row.createSpan({ cls: "hl-map-ev-tag", text: tag });
			const prev = row.createSpan({ cls: "hl-map-ev-preview" });
			void eventPreview(this.plugin, evId).then((p) => {
				prev.setText(
					p.text
						? (p.fromSource ? "§ " : "") + p.text
						: "（无内容）"
				);
			});
			const hour = row.createEl("button", {
				cls: "hl-map-ev-btn",
				text: "⌛",
			});
			hour.setAttr("aria-label", "事件菜单");
			hour.addEventListener("click", (e) =>
				openEvMenu(this.plugin, e, evId, tag)
			);
			const x = row.createEl("button", {
				cls: "hl-map-ev-btn hl-map-ev-x",
				text: "×",
			});
			x.setAttr("aria-label", "解除关联");
			x.addEventListener("click", () => {
				this.entry.events = this.entry.events.filter(
					(e) => e !== evId
				);
				void this.render();
			});
		}

		// Linked entities.
		contentEl.createDiv({ cls: "hl-overline", text: "词条" });
		const entRow = contentEl.createDiv({ cls: "hl-map-links" });
		const entities = await this.plugin.store.readEntities();
		for (const entId of this.entry.entities) {
			const chip = entRow.createSpan({
				cls: "hl-map-chip hl-map-chip-link",
			});
			const ent = entities.get(entId);
			const name = chip.createSpan({
				text: ent ? displayName(ent) : entId,
			});
			name.addEventListener("click", () => {
				this.close();
				void this.plugin.openEntityView(entId);
			});
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
		contentEl.createDiv({ cls: "hl-overline", text: "注记" });
		const notes = contentEl.createEl("textarea", {
			cls: "hl-map-notes",
			attr: { placeholder: "markdown，可留空" },
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
					new Notice("请先粘贴或选择图片");
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

	private pickFromVault(): void {
		new ImageSuggestModal(this.app, (f) => {
			this.entry.image = f.path;
			if (!this.entry.title) this.entry.title = f.basename;
			void this.render();
		}).open();
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

// Bare full-size image viewer: click a map row to look at the map; Esc or
// a click anywhere closes.
export class MapViewerModal extends Modal {
	constructor(app: App, private file: TFile, private title: string) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("hl-map-viewer-window");
		const { contentEl } = this;
		contentEl.addClass("hl-map-viewer");
		const img = contentEl.createEl("img");
		img.src = this.app.vault.getResourcePath(this.file);
		if (this.title)
			contentEl.createDiv({
				cls: "hl-map-viewer-title",
				text: this.title,
			});
		contentEl.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
