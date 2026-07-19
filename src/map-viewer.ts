// Full-size map occlusion editor. Reviewing happens in the normal quiz
// surfaces (deck player, practice modal, reminder) — this window only looks
// at the picture and edits the frames.
//
// Dragging pans the picture, the wheel zooms around the cursor and
// double-click resets to fit. Frames are created explicitly: the "+ 新遮罩"
// button arms a one-shot crosshair, the next drag draws the frame. Dragging
// a frame moves it, its corner handle resizes, × deletes. Selecting a frame
// opens its card fields in the side panel: an optional front question, the
// answer, and an optional hint — question and answer through the same live
// markdown editor as event summaries ({db} entity completion, right-click
// annotation). Geometry is stored in image fractions, so frames follow the
// picture through any zoom.
//
// Nothing touches maps.md until 保存 — closing with unsaved edits asks.

import { App, EventRef, Modal, TFile, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { MapEntry, MapOcclusion } from "./maps-format";
import { generateId } from "./id";
import { DbType, EntityEntry } from "./db-format";
import { EntityModal } from "./entity-modal";
import { LiveEditor, registerEscapeFirst } from "./live-editor";
import { positionBox, syncMapQuizzes } from "./map-occlusion";
import { MapStage, trackDrag } from "./map-stage";

// Frames smaller than this fraction on either axis are accidental clicks.
const MIN_FRAC = 0.005;

export class MapOcclusionEditor extends Modal {
	private map: MapEntry;
	private selected = "";
	private drawMode = false;
	private entities: EntityEntry[] = [];
	private types: DbType[] = [];
	private editors: LiveEditor[] = [];
	private dirty = false;
	private closing = false;
	private entitiesWatch?: EventRef;

	private mapStage?: MapStage;
	private side!: HTMLElement;
	private drawBtn!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private footNote!: HTMLElement;
	private boxEls = new Map<string, HTMLElement>();
	private rowEls = new Map<string, HTMLElement>();

	// When opened from a specific map quiz, that occlusion is pre-selected
	// and the view focuses on it once the picture is ready.
	private focusId: string;
	private needsFocus: boolean;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		map: MapEntry,
		private onChanged?: () => void,
		focusOcclusionId = ""
	) {
		super(app);
		this.map = JSON.parse(JSON.stringify(map)) as MapEntry;
		this.map.occlusions ??= [];
		for (const occ of this.map.occlusions) {
			occ.question ??= "";
			occ.hint ??= "";
		}
		const hasFocus =
			!!focusOcclusionId &&
			this.map.occlusions.some((o) => o.id === focusOcclusionId);
		this.focusId = hasFocus ? focusOcclusionId : "";
		this.selected = this.focusId;
		this.needsFocus = hasFocus;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("hl-occ-viewer-window");
		registerEscapeFirst(this.scope, () => {
			if (this.editors.some((e) => e.closeSuggestIfOpen())) return true;
			if (this.drawMode) {
				this.setDrawMode(false);
				return true;
			}
			return false;
		});
		this.entities = [...(await this.plugin.store.readEntities()).values()];
		this.types = await this.plugin.store.readDbTypes();
		this.entitiesWatch = this.app.vault.on("modify", (f) => {
			if (
				f instanceof TFile &&
				f.path === this.plugin.store.entitiesFilePath()
			)
				void this.reloadEntities();
		});
		this.render();
	}

	private async reloadEntities(): Promise<void> {
		this.entities = [...(await this.plugin.store.readEntities()).values()];
		for (const e of this.editors) e.refreshDecorations();
	}

	private typeColor(name: string): string | null {
		return this.types.find((t) => t.name === name)?.color ?? null;
	}

	private imageFile(): TFile | null {
		return this.app.metadataCache.getFirstLinkpathDest(
			this.map.image,
			""
		) as TFile | null;
	}

	private occOf(id: string): MapOcclusion | undefined {
		return this.map.occlusions.find((o) => o.id === id);
	}

	// ---------------------------------------------------------------- render

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hl-occ-viewer");

		const head = contentEl.createDiv({ cls: "hl-occ-head" });
		head.createSpan({
			cls: "hl-occ-title",
			text: this.map.title || this.map.image,
		});
		head.createSpan({
			cls: "hl-occ-count",
			text: this.map.occlusions.length
				? `${this.map.occlusions.length} 个遮罩`
				: "",
		});
		const headSpacer = head.createSpan({ cls: "hl-occ-head-spacer" });
		void headSpacer;
		this.drawBtn = head.createEl("button", { cls: "hl-occ-draw-btn" });
		setIcon(this.drawBtn, "plus");
		this.drawBtn.createSpan({ text: "新遮罩" });
		this.drawBtn.addEventListener("click", () =>
			this.setDrawMode(!this.drawMode)
		);

		const body = contentEl.createDiv({ cls: "hl-occ-body" });
		const stageHost = body.createDiv({ cls: "hl-occ-stage-host" });
		this.side = body.createDiv({ cls: "hl-occ-side" });

		const file = this.imageFile();
		if (!file) {
			stageHost.createDiv({
				cls: "hl-empty",
				text: `找不到图片：${this.map.image}`,
			});
			return;
		}
		this.mapStage = new MapStage(
			stageHost,
			this.app.vault.getResourcePath(file),
			(e) => this.onStagePress(e)
		);
		this.mapStage.wrap.createDiv({
			cls: "hl-occ-nav-hint",
			text: "拖拽平移 · 滚轮缩放 · 双击复位",
		});
		this.paintDrawMode();

		this.boxEls.clear();
		for (const occ of this.map.occlusions) this.buildBox(occ);
		this.paintSide();
		if (this.needsFocus) {
			const occ = this.occOf(this.focusId);
			if (occ) this.mapStage.focusOn(occ);
			this.needsFocus = false;
		}

		const foot = contentEl.createDiv({ cls: "hl-occ-foot" });
		this.footNote = foot.createSpan({ cls: "hl-occ-foot-note" });
		const footSpacer = foot.createSpan({ cls: "hl-modal-foot-spacer" });
		void footSpacer;
		this.saveBtn = foot.createEl("button", {
			cls: "mod-cta",
			text: "保存",
		});
		this.saveBtn.addEventListener("click", () => void this.save());
		this.paintFoot();
	}

	private setDrawMode(on: boolean): void {
		this.drawMode = on;
		this.paintDrawMode();
	}

	private paintDrawMode(): void {
		this.drawBtn?.toggleClass("is-active", this.drawMode);
		this.mapStage?.wrap.toggleClass("is-drawing", this.drawMode);
	}

	private buildBox(occ: MapOcclusion): void {
		if (!this.mapStage) return;
		const box = this.mapStage.stage.createDiv({ cls: "hl-occ-box is-edit" });
		positionBox(box, occ);
		this.boxEls.set(occ.id, box);
		this.paintBox(occ.id);
		const handle = box.createDiv({ cls: "hl-occ-handle" });
		void handle;
		const x = box.createDiv({ cls: "hl-occ-x", text: "×" });
		x.addEventListener("mousedown", (e) => e.stopPropagation());
		x.addEventListener("click", (e) => {
			e.stopPropagation();
			this.deleteOcclusion(occ.id);
		});
	}

	private paintBox(id: string): void {
		const box = this.boxEls.get(id);
		if (!box) return;
		box.toggleClass("is-current", this.selected === id);
	}

	private paintAllBoxes(): void {
		for (const id of this.boxEls.keys()) this.paintBox(id);
	}

	// ------------------------------------------------------------ side panel

	private paintSide(): void {
		this.side.empty();
		this.rowEls.clear();
		for (const e of this.editors) e.destroy();
		this.editors = [];
		if (!this.map.occlusions.length) {
			this.side.createDiv({
				cls: "hl-occ-side-empty",
				text: "还没有遮罩。点「+ 新遮罩」，再在图上拖拽框选一个区域。",
			});
			return;
		}
		const list = this.side.createDiv({ cls: "hl-occ-list" });
		this.map.occlusions.forEach((occ, i) => {
			const row = list.createDiv({ cls: "hl-occ-row" });
			this.rowEls.set(occ.id, row);
			const isSel = this.selected === occ.id;
			row.toggleClass("is-current", isSel);
			const head = row.createDiv({ cls: "hl-occ-row-head" });
			head.createSpan({ cls: "hl-occ-row-num", text: String(i + 1) });
			head.createSpan({
				cls: "hl-occ-row-preview",
				text:
					occ.question.trim() ||
					occ.answer.trim().split("\n")[0] ||
					"（空）",
			});
			head.addEventListener("click", () =>
				this.select(isSel ? "" : occ.id)
			);
			head.addEventListener("mouseenter", () =>
				this.boxEls.get(occ.id)?.addClass("is-hover")
			);
			head.addEventListener("mouseleave", () =>
				this.boxEls.get(occ.id)?.removeClass("is-hover")
			);
			if (isSel) this.paintFields(row, occ);
		});
	}

	// The selected frame's card fields: optional front question, the answer
	// (the card back), and an optional hint.
	private paintFields(row: HTMLElement, occ: MapOcclusion): void {
		const fields = row.createDiv({ cls: "hl-occ-fields" });

		fields.createDiv({ cls: "hl-occ-field-label", text: "正面问题（可选）" });
		const qEl = fields.createDiv({ cls: "hl-occ-editor is-single" });
		this.editors.push(
			this.makeEditor(qEl, occ.question, "默认：地图名 · 遮罩序号", (v) => {
				occ.question = v.replace(/\n+/g, " ");
				this.markDirty();
			})
		);

		fields.createDiv({ cls: "hl-occ-field-label", text: "答案" });
		const aEl = fields.createDiv({ cls: "hl-occ-editor" });
		this.editors.push(
			this.makeEditor(aEl, occ.answer, "揭开遮罩后显示的内容…", (v) => {
				occ.answer = v;
				this.markDirty();
			})
		);

		fields.createDiv({ cls: "hl-occ-field-label", text: "提示（可选）" });
		const hEl = fields.createDiv({ cls: "hl-occ-editor is-single" });
		this.editors.push(
			this.makeEditor(hEl, occ.hint, "", (v) => {
				occ.hint = v.replace(/\n+/g, " ");
				this.markDirty();
			})
		);

		const foot = fields.createDiv({ cls: "hl-occ-field-foot" });
		const del = foot.createEl("button", { cls: "hl-occ-delete" });
		setIcon(del, "trash-2");
		del.createSpan({ text: "删除" });
		del.addEventListener("click", () => this.deleteOcclusion(occ.id));
	}

	private makeEditor(
		host: HTMLElement,
		value: string,
		placeholder: string,
		onChange: (value: string) => void
	): LiveEditor {
		return new LiveEditor(host, {
			value,
			placeholder,
			onChange,
			colorFor: (id) => {
				const e = this.entities.find((x) => x.id === id);
				return e ? this.typeColor(e.type) ?? "" : null;
			},
			onOpenEntity: (id) => this.editEntity(id),
			onOpenEntityPage: (id) => void this.plugin.openEntityView(id),
			annotate: {
				entities: () => this.entities,
				typeColor: (name) => this.typeColor(name),
				onCreate: (word, apply) => this.createEntity(word, apply),
				autoTrigger: () => this.plugin.settings.completeAutoTrigger,
				lastToken: () => this.plugin.settings.completeLastToken,
			},
		});
	}

	private select(id: string): void {
		this.selected = id;
		this.paintAllBoxes();
		this.paintSide();
		if (id)
			this.rowEls
				.get(id)
				?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}

	// ------------------------------------------------------------------ edit

	private deleteOcclusion(id: string): void {
		this.map.occlusions = this.map.occlusions.filter((o) => o.id !== id);
		this.boxEls.get(id)?.remove();
		this.boxEls.delete(id);
		if (this.selected === id) this.selected = "";
		this.markDirty();
		this.render();
	}

	private addOcclusion(x: number, y: number, w: number, h: number): void {
		const occ: MapOcclusion = {
			id: generateId((cand) =>
				this.map.occlusions.some((o) => o.id === cand)
			),
			x,
			y,
			w,
			h,
			question: "",
			hint: "",
			answer: "",
		};
		this.map.occlusions.push(occ);
		this.selected = occ.id;
		this.markDirty();
		this.render();
	}

	// ------------------------------------------------------------------ save

	private markDirty(): void {
		this.dirty = true;
		this.paintFoot();
	}

	private paintFoot(): void {
		if (!this.saveBtn) return;
		this.saveBtn.disabled = !this.dirty;
		this.footNote.setText(this.dirty ? "有未保存的更改" : "");
	}

	private async save(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		this.paintFoot();
		await this.plugin.store.upsertMap(this.map);
		await syncMapQuizzes(this.plugin, this.map);
		this.onChanged?.();
	}

	// Closing with unsaved edits asks; nothing is written until 保存.
	close(): void {
		if (this.dirty && !this.closing) {
			new UnsavedFramesModal(
				this.app,
				() =>
					void this.save().then(() => {
						this.closing = true;
						super.close();
					}),
				() => {
					this.closing = true;
					super.close();
				}
			).open();
			return;
		}
		super.close();
	}

	// ------------------------------------------------------------- zoom/pan

	// Primary press on the stage: draw when armed, drag frames otherwise;
	// empty picture space falls through to the stage's pan.
	private onStagePress(e: MouseEvent): boolean {
		if (e.ctrlKey) return false;
		if (this.drawMode) {
			this.startDraw(e);
			return true;
		}
		const target = e.target as HTMLElement;
		const boxId = this.boxIdAt(target);
		if (!boxId) return false;
		if (target.hasClass("hl-occ-handle")) this.startResize(e, boxId);
		else this.startMove(e, boxId);
		return true;
	}

	private boxIdAt(el: HTMLElement): string {
		for (const [id, box] of this.boxEls)
			if (box === el || box.contains(el)) return id;
		return "";
	}

	private startDraw(e: MouseEvent): void {
		const stage = this.mapStage;
		if (!stage) return;
		const start = stage.toFrac(e);
		if (!start) return;
		e.preventDefault();
		const ghost = stage.stage.createDiv({
			cls: "hl-occ-box is-edit is-ghost",
		});
		const place = (
			a: { x: number; y: number },
			b: { x: number; y: number }
		): void =>
			positionBox(ghost, {
				id: "",
				x: Math.min(a.x, b.x),
				y: Math.min(a.y, b.y),
				w: Math.abs(a.x - b.x),
				h: Math.abs(a.y - b.y),
				question: "",
				hint: "",
				answer: "",
			});
		place(start, start);
		let last = start;
		trackDrag(
			(ev) => {
				const cur = stage.toFrac(ev);
				if (!cur) return;
				last = cur;
				place(start, cur);
			},
			() => {
				ghost.remove();
				this.setDrawMode(false);
				const w = Math.abs(start.x - last.x);
				const h = Math.abs(start.y - last.y);
				if (w < MIN_FRAC || h < MIN_FRAC) return;
				this.addOcclusion(
					Math.min(start.x, last.x),
					Math.min(start.y, last.y),
					w,
					h
				);
			}
		);
	}

	private startMove(e: MouseEvent, id: string): void {
		const stage = this.mapStage;
		const occ = this.occOf(id);
		const start = stage?.toFrac(e);
		if (!stage || !occ || !start) return;
		e.preventDefault();
		if (this.selected !== id) this.select(id);
		const ox = occ.x;
		const oy = occ.y;
		let moved = false;
		trackDrag(
			(ev) => {
				const cur = stage.toFrac(ev);
				if (!cur) return;
				moved = true;
				occ.x = Math.min(1 - occ.w, Math.max(0, ox + cur.x - start.x));
				occ.y = Math.min(1 - occ.h, Math.max(0, oy + cur.y - start.y));
				const box = this.boxEls.get(id);
				if (box) positionBox(box, occ);
			},
			() => {
				if (moved) this.markDirty();
			}
		);
	}

	private startResize(e: MouseEvent, id: string): void {
		const stage = this.mapStage;
		const occ = this.occOf(id);
		if (!stage || !occ) return;
		e.preventDefault();
		e.stopPropagation();
		this.trackResize(stage, occ, id);
	}

	private trackResize(stage: MapStage, occ: MapOcclusion, id: string): void {
		trackDrag(
			(ev) => {
				const cur = stage.toFrac(ev);
				if (!cur) return;
				occ.w = Math.min(1 - occ.x, Math.max(MIN_FRAC, cur.x - occ.x));
				occ.h = Math.min(1 - occ.y, Math.max(MIN_FRAC, cur.y - occ.y));
				const box = this.boxEls.get(id);
				if (box) positionBox(box, occ);
			},
			() => this.markDirty()
		);
	}

	// -------------------------------------------------------------- entities

	private editEntity(id: string): void {
		const entity = this.entities.find((e) => e.id === id);
		if (!entity) {
			void this.plugin.openEntityView(id);
			return;
		}
		new EntityModal(this.app, this.plugin, entity, false, (saved) => {
			const i = this.entities.findIndex((e) => e.id === saved.id);
			if (i >= 0) this.entities[i] = saved;
			for (const e of this.editors) e.refreshDecorations();
		}).open();
	}

	private createEntity(word: string, apply: (e: EntityEntry) => void): void {
		const entity: EntityEntry = {
			id: generateId((id) => this.entities.some((e) => e.id === id)),
			type: "",
			labels: [
				{
					lang: this.plugin.settings.entityLangs[0] ?? "zh",
					text: word,
				},
			],
			readings: [],
			audios: [],
			tags: [],
			body: "",
		};
		new EntityModal(this.app, this.plugin, entity, true, (saved) => {
			this.entities.push(saved);
			apply(saved);
			for (const e of this.editors) e.refreshDecorations();
		}).open();
	}

	onClose(): void {
		if (this.entitiesWatch) this.app.vault.offref(this.entitiesWatch);
		for (const e of this.editors) e.destroy();
		this.contentEl.empty();
	}
}

// Three-way prompt shown when the editor is closed with unsaved edits.
class UnsavedFramesModal extends Modal {
	constructor(
		app: App,
		private onSave: () => void,
		private onDiscard: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "未保存的更改" });
		contentEl.createEl("p", {
			text: "这张地图的遮罩有未保存的更改。",
		});
		const foot = contentEl.createDiv({ cls: "hl-modal-foot" });
		const stay = foot.createEl("button", { text: "继续编辑" });
		stay.addEventListener("click", () => this.close());
		const discard = foot.createEl("button", { text: "放弃更改" });
		discard.addEventListener("click", () => {
			this.close();
			this.onDiscard();
		});
		const save = foot.createEl("button", {
			cls: "mod-cta",
			text: "保存并关闭",
		});
		save.addEventListener("click", () => {
			this.close();
			this.onSave();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
