// Full-size map occlusion editor. Reviewing happens in the normal quiz
// surfaces (deck player, practice modal, reminder) — this window only looks
// at the picture and edits the frames.
//
// Drag on the picture to add a frame; drag a frame to move it, its corner
// handle to resize, × to delete. Selecting a frame (click on the picture or
// in the list) opens its card fields in the side panel: an optional front
// question, the answer, and an optional hint — question and answer through
// the same live markdown editor as event summaries ({db} entity completion,
// right-click annotation). Geometry is stored in image fractions, so frames
// follow the picture through any zoom.
//
// Wheel zooms around the cursor (out past fit as well), drag with the
// middle button or Ctrl pans, double-click resets to fit.

import { App, EventRef, Modal, TFile, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { MapEntry, MapOcclusion } from "./maps-format";
import { generateId } from "./id";
import { DbType, EntityEntry } from "./db-format";
import { EntityModal } from "./entity-modal";
import { LiveEditor, registerEscapeFirst } from "./live-editor";
import { positionBox, syncMapQuizzes } from "./map-occlusion";

const MIN_SCALE = 0.3;
const MAX_SCALE = 12;
// Frames smaller than this fraction on either axis are accidental clicks.
const MIN_FRAC = 0.005;

export class MapOcclusionEditor extends Modal {
	private map: MapEntry;
	private scale = 1;
	private tx = 0;
	private ty = 0;
	private selected = "";
	private entities: EntityEntry[] = [];
	private types: DbType[] = [];
	private editors: LiveEditor[] = [];
	private saveTimer: number | null = null;
	private dirty = false;
	private entitiesWatch?: EventRef;

	private stageWrap!: HTMLElement;
	private stage!: HTMLElement;
	private fitW = 0;
	private side!: HTMLElement;
	private boxEls = new Map<string, HTMLElement>();
	private rowEls = new Map<string, HTMLElement>();

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		map: MapEntry,
		private onChanged?: () => void
	) {
		super(app);
		this.map = JSON.parse(JSON.stringify(map)) as MapEntry;
		this.map.occlusions ??= [];
		for (const occ of this.map.occlusions) {
			occ.question ??= "";
			occ.hint ??= "";
		}
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("hl-occ-viewer-window");
		registerEscapeFirst(this.scope, () =>
			this.editors.some((e) => e.closeSuggestIfOpen())
		);
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
				: "在图上拖拽框选遮罩",
		});

		const body = contentEl.createDiv({ cls: "hl-occ-body" });
		this.stageWrap = body.createDiv({ cls: "hl-occ-stage-wrap" });
		this.side = body.createDiv({ cls: "hl-occ-side" });

		const file = this.imageFile();
		if (!file) {
			this.stageWrap.createDiv({
				cls: "hl-empty",
				text: `找不到图片：${this.map.image}`,
			});
			return;
		}
		this.stage = this.stageWrap.createDiv({ cls: "hl-occ-stage" });
		const img = this.stage.createEl("img", { cls: "hl-occ-img" });
		img.src = this.app.vault.getResourcePath(file);
		img.draggable = false;
		const settle = (): void => {
			if (this.fitW) {
				img.style.width = `${this.fitW}px`;
				this.applyTransform();
			} else this.fitToWrap();
		};
		if (img.complete) window.setTimeout(settle, 0);
		else img.addEventListener("load", settle, { once: true });
		this.applyTransform();

		this.stageWrap.createDiv({
			cls: "hl-occ-nav-hint",
			text: "滚轮缩放 · 拖拽平移 · 双击复位",
		});

		this.boxEls.clear();
		for (const occ of this.map.occlusions) this.buildBox(occ);
		this.wireStage();
		this.paintSide();
	}

	private fitToWrap(): void {
		const img = this.stage?.querySelector("img");
		if (!img || !img.naturalWidth || !img.naturalHeight) return;
		const wrap = this.stageWrap.getBoundingClientRect();
		if (!wrap.width || !wrap.height) return;
		const fit = Math.min(
			wrap.width / img.naturalWidth,
			wrap.height / img.naturalHeight
		);
		this.fitW = img.naturalWidth * fit;
		img.style.width = `${this.fitW}px`;
		this.scale = 1;
		this.tx = (wrap.width - this.fitW) / 2;
		this.ty = (wrap.height - img.naturalHeight * fit) / 2;
		this.applyTransform();
	}

	private applyTransform(): void {
		if (!this.stage) return;
		this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
	}

	private buildBox(occ: MapOcclusion): void {
		const box = this.stage.createDiv({ cls: "hl-occ-box is-edit" });
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
				text: "还没有遮罩。在图上拖拽框选一个区域，它就会成为一张卡片。",
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
				this.scheduleSave();
			})
		);

		fields.createDiv({ cls: "hl-occ-field-label", text: "答案" });
		const aEl = fields.createDiv({ cls: "hl-occ-editor" });
		this.editors.push(
			this.makeEditor(aEl, occ.answer, "揭开遮罩后显示的内容…", (v) => {
				occ.answer = v;
				this.scheduleSave();
			})
		);

		fields.createDiv({ cls: "hl-occ-field-label", text: "提示（可选）" });
		const hEl = fields.createDiv({ cls: "hl-occ-editor is-single" });
		this.editors.push(
			this.makeEditor(hEl, occ.hint, "", (v) => {
				occ.hint = v.replace(/\n+/g, " ");
				this.scheduleSave();
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
		this.scheduleSave();
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
		this.scheduleSave();
		this.render();
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.save(), 600);
	}

	private async save(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		await this.plugin.store.upsertMap(this.map);
		await syncMapQuizzes(this.plugin, this.map);
		this.onChanged?.();
	}

	// ------------------------------------------------------------- zoom/pan

	// Pointer position → image fractions, valid under any zoom because the
	// image rect itself carries the transform.
	private toFrac(e: MouseEvent): { x: number; y: number } | null {
		const img = this.stage.querySelector("img");
		if (!img) return null;
		const rect = img.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		return {
			x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
			y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
		};
	}

	private wireStage(): void {
		const wrap = this.stageWrap;
		wrap.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const rect = wrap.getBoundingClientRect();
				const px = e.clientX - rect.left;
				const py = e.clientY - rect.top;
				const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
				const next = Math.min(
					MAX_SCALE,
					Math.max(MIN_SCALE, this.scale * factor)
				);
				if (next === this.scale) return;
				// Keep the point under the cursor fixed.
				this.tx = px - ((px - this.tx) / this.scale) * next;
				this.ty = py - ((py - this.ty) / this.scale) * next;
				this.scale = next;
				this.applyTransform();
			},
			{ passive: false }
		);
		wrap.addEventListener("dblclick", () => this.fitToWrap());
		wrap.addEventListener("mousedown", (e) => {
			if (e.button === 1 || e.ctrlKey) {
				this.startPan(e);
				return;
			}
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			const boxId = this.boxIdAt(target);
			if (boxId && target.hasClass("hl-occ-handle"))
				this.startResize(e, boxId);
			else if (boxId) this.startMove(e, boxId);
			else this.startDraw(e);
		});
	}

	private boxIdAt(el: HTMLElement): string {
		for (const [id, box] of this.boxEls)
			if (box === el || box.contains(el)) return id;
		return "";
	}

	private startPan(e: MouseEvent): void {
		e.preventDefault();
		const sx = e.clientX - this.tx;
		const sy = e.clientY - this.ty;
		this.trackDrag(
			(ev) => {
				this.tx = ev.clientX - sx;
				this.ty = ev.clientY - sy;
				this.applyTransform();
			},
			() => undefined
		);
	}

	private startDraw(e: MouseEvent): void {
		const start = this.toFrac(e);
		if (!start) return;
		e.preventDefault();
		const ghost = this.stage.createDiv({
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
		this.trackDrag(
			(ev) => {
				const cur = this.toFrac(ev);
				if (!cur) return;
				last = cur;
				place(start, cur);
			},
			() => {
				ghost.remove();
				const w = Math.abs(start.x - last.x);
				const h = Math.abs(start.y - last.y);
				if (w < MIN_FRAC || h < MIN_FRAC) {
					this.select("");
					return;
				}
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
		const occ = this.occOf(id);
		const start = this.toFrac(e);
		if (!occ || !start) return;
		e.preventDefault();
		if (this.selected !== id) this.select(id);
		const ox = occ.x;
		const oy = occ.y;
		let moved = false;
		this.trackDrag(
			(ev) => {
				const cur = this.toFrac(ev);
				if (!cur) return;
				moved = true;
				occ.x = Math.min(1 - occ.w, Math.max(0, ox + cur.x - start.x));
				occ.y = Math.min(1 - occ.h, Math.max(0, oy + cur.y - start.y));
				const box = this.boxEls.get(id);
				if (box) positionBox(box, occ);
			},
			() => {
				if (moved) this.scheduleSave();
			}
		);
	}

	private startResize(e: MouseEvent, id: string): void {
		const occ = this.occOf(id);
		if (!occ) return;
		e.preventDefault();
		e.stopPropagation();
		this.trackDrag(
			(ev) => {
				const cur = this.toFrac(ev);
				if (!cur) return;
				occ.w = Math.min(1 - occ.x, Math.max(MIN_FRAC, cur.x - occ.x));
				occ.h = Math.min(1 - occ.y, Math.max(MIN_FRAC, cur.y - occ.y));
				const box = this.boxEls.get(id);
				if (box) positionBox(box, occ);
			},
			() => this.scheduleSave()
		);
	}

	private trackDrag(
		onMove: (e: MouseEvent) => void,
		onUp: (e: MouseEvent) => void
	): void {
		const move = (e: MouseEvent): void => onMove(e);
		const up = (e: MouseEvent): void => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
			onUp(e);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
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
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		void this.save();
		for (const e of this.editors) e.destroy();
		this.contentEl.empty();
	}
}
