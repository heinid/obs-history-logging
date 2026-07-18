// Create / edit a historical map entry (maps.md). The image is the hero:
// paste or drop a picture straight into the modal (it is saved into the
// vault via the attachment settings), or pick an existing vault image. All
// fields share one label/content grid; events are linked via a timeline-style
// search over tags, summaries and source blocks, and render as rich rows.

import {
	App,
	FuzzySuggestModal,
	MarkdownRenderer,
	Modal,
	Notice,
	TFile,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { MapEntry } from "./maps-format";
import { generateId } from "./id";
import { displayName } from "./db-format";
import { EntitySuggestModal, EntityTagSuggest } from "./entity-modal";
import { eventPreview } from "./map-candidates";
import { openEvMenu } from "./ev-menu";
import { describeYear, parseYearTag } from "./year-tag";
import { TimelineEntry, scanVault } from "./scan";
import { matchesQuery, parseQuery } from "./query";

export class MapModal extends Modal {
	private entry: MapEntry;
	private knownTags: string[] = [];
	private timeline: TimelineEntry[] | null = null;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		entry: MapEntry,
		private isNew: boolean,
		private onSaved?: (m: MapEntry) => void
	) {
		super(app);
		this.entry = JSON.parse(JSON.stringify(entry)) as MapEntry;
		this.entry.tags ??= [];
		this.entry.occlusions ??= [];
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
		const maps = await this.plugin.store.readMaps();
		this.knownTags = [
			...new Set([...maps.values()].flatMap((m) => m.tags)),
		].sort((a, b) => a.localeCompare(b));
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

	// Scan once per modal; the event search filters these entries.
	private async timelineEntries(): Promise<TimelineEntry[]> {
		if (!this.timeline)
			this.timeline = await scanVault(
				this.app,
				this.plugin.store,
				this.plugin.settings.dataFolder
			);
		return this.timeline;
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
			zone.createSpan({
				cls: "hl-map-dropzone-hint",
				text: this.entry.image
					? `找不到图片：${this.entry.image}`
					: "粘贴（Ctrl+V）或拖入图片，或",
			});
			const pick = zone.createEl("button", {
				cls: "hl-map-hero-btn",
				text: "从库中选择…",
			});
			pick.addEventListener("click", () => this.pickFromVault());
		}

		const grid = contentEl.createDiv({ cls: "hl-map-grid" });
		const row = (label: string): HTMLElement => {
			grid.createDiv({ cls: "hl-map-grid-label", text: label });
			return grid.createDiv({ cls: "hl-map-grid-content" });
		};

		// Title.
		const titleCell = row("标题");
		const title = titleCell.createEl("input", {
			cls: "hl-map-input",
			type: "text",
			attr: { placeholder: "地图标题" },
		});
		title.value = this.entry.title;
		title.addEventListener(
			"input",
			() => (this.entry.title = title.value)
		);

		// Tags: chips plus an autocompleted input, same as the entity modal.
		this.renderTagsCell(row("标签"));

		// Events: rich rows plus a timeline-style search to add more.
		const evCell = row("事件");
		evCell.addClass("hl-map-ev-cell");
		const events = await this.plugin.store.readEvents();
		for (const evId of this.entry.events) {
			const tag = events.get(evId)?.tag ?? "";
			const evRow = evCell.createDiv({ cls: "hl-map-ev-row" });
			const decoded = tag ? parseYearTag(tag) : null;
			evRow.createSpan({
				cls: "hl-map-ev-year",
				text: decoded ? describeYear(decoded) : "？",
			});
			if (tag) evRow.createSpan({ cls: "hl-map-ev-tag", text: tag });
			const prev = evRow.createSpan({ cls: "hl-map-ev-preview" });
			void eventPreview(this.plugin, evId).then((p) => {
				if (!p.text) {
					prev.setText("（无内容）");
					return;
				}
				if (p.fromSource)
					prev.createSpan({ cls: "hl-map-ev-src", text: "§ " });
				this.renderPreview(prev, p.text);
			});
			const hour = evRow.createEl("button", {
				cls: "hl-map-ev-btn",
				text: "⌛",
			});
			hour.setAttr("aria-label", "事件菜单");
			hour.addEventListener("click", (e) =>
				openEvMenu(this.plugin, e, evId, tag)
			);
			const x = evRow.createEl("button", {
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
		this.renderEventSearch(evCell);

		// Entities.
		const entCell = row("词条");
		entCell.addClass("hl-map-links");
		const entities = await this.plugin.store.readEntities();
		for (const entId of this.entry.entities) {
			const chip = entCell.createSpan({
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
		const add = entCell.createEl("button", {
			cls: "hl-map-chip-add",
			text: "＋ 词条",
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
		const notes = row("注记").createEl("textarea", {
			cls: "hl-map-notes",
			attr: { placeholder: "markdown，可留空", rows: "2" },
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

	private renderTagsCell(cell: HTMLElement): void {
		cell.addClass("hl-map-links");
		const paint = (): void => {
			cell.empty();
			this.entry.tags.forEach((tag, i) => {
				const chip = cell.createSpan({
					cls: "hl-tag-chip",
					text: tag,
				});
				const x = chip.createSpan({
					cls: "hl-tag-chip-x",
					text: "✕",
				});
				x.addEventListener("click", () => {
					this.entry.tags.splice(i, 1);
					paint();
				});
			});
			const input = cell.createEl("input", {
				type: "text",
				cls: "hl-tag-chip-input",
			});
			input.placeholder = this.entry.tags.length ? "" : "＋ 标签";
			const commit = (): void => {
				const v = input.value.trim().replace(/[,，]$/, "").trim();
				if (v && !this.entry.tags.includes(v)) {
					this.entry.tags.push(v);
					paint();
					(
						cell.querySelector("input") as HTMLInputElement | null
					)?.focus();
				} else input.value = "";
			};
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter" || ev.key === ",") {
					ev.preventDefault();
					commit();
				}
				if (
					ev.key === "Backspace" &&
					!input.value &&
					this.entry.tags.length
				) {
					this.entry.tags.pop();
					paint();
					(
						cell.querySelector("input") as HTMLInputElement | null
					)?.focus();
				}
			});
			input.addEventListener("blur", commit);
			new EntityTagSuggest(
				this.app,
				input,
				() =>
					this.knownTags.filter(
						(t) => !this.entry.tags.includes(t)
					),
				(tag) => {
					this.entry.tags.push(tag);
					paint();
					(
						cell.querySelector("input") as HTMLInputElement | null
					)?.focus();
				}
			);
		};
		paint();
	}

	// Timeline-style event search: the query hits year tags, summaries and
	// note source blocks; picking a hit links the event.
	private renderEventSearch(cell: HTMLElement): void {
		const box = cell.createDiv({ cls: "hl-map-ev-search" });
		const input = box.createEl("input", {
			cls: "hl-map-input",
			type: "search",
			attr: { placeholder: "＋ 搜索关联事件（年代 tag / 内容）…" },
		});
		const results = box.createDiv({ cls: "hl-map-ev-results" });
		let timer: number | null = null;
		input.addEventListener("input", () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				void this.paintEventResults(input.value, results);
			}, 150);
		});
	}

	private async paintEventResults(
		query: string,
		host: HTMLElement
	): Promise<void> {
		host.empty();
		const q = query.trim();
		if (!q) return;
		const pq = parseQuery(q);
		const entries = await this.timelineEntries();
		const seen = new Set<string>();
		const hits: TimelineEntry[] = [];
		for (const e of entries) {
			if (!e.evId || seen.has(e.evId)) continue;
			if (this.entry.events.includes(e.evId)) continue;
			const hay = `${e.tag} ${e.snippet} ${
				e.summary ?? ""
			}`.toLowerCase();
			if (!matchesQuery(hay, pq)) continue;
			seen.add(e.evId);
			hits.push(e);
			if (hits.length >= 8) break;
		}
		if (!hits.length) {
			host.createDiv({
				cls: "hl-map-ev-result-empty",
				text: "没有匹配的事件。",
			});
			return;
		}
		for (const e of hits) {
			const item = host.createDiv({ cls: "hl-map-ev-result" });
			const decoded = parseYearTag(e.tag);
			item.createSpan({
				cls: "hl-map-ev-year",
				text: decoded ? describeYear(decoded) : e.tag,
			});
			const prev = item.createSpan({ cls: "hl-map-ev-preview" });
			this.renderPreview(prev, (e.summary ?? "").trim() || e.snippet);
			item.addEventListener("click", () => {
				if (e.evId) this.entry.events.push(e.evId);
				void this.render();
			});
		}
	}

	// One-line markdown preview (bold, italics…) inside an ellipsized span.
	private renderPreview(host: HTMLElement, text: string): void {
		void MarkdownRenderer.render(this.app, text, host, "", this.plugin);
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
		tags: [],
		body: "",
		occlusions: [],
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


