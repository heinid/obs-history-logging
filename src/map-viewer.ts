// Full-size map viewer with the occlusion workflow. One surface, two modes:
//
// 复习 (default): frames render as solid covers. Clicking one turns it
// transparent and shows its answer — full markdown with inline entity
// behaviour — in the side panel, followed by 记得/不记得 (keys 1/2) wired to
// the frame's own quiz mastery loop. The panel lists every frame; list and
// picture highlight each other both ways.
//
// 标记 (edit): drag on the picture to add a frame; drag a frame to move it,
// its corner handle to resize, × to delete. Selecting a frame edits its
// answer in the side panel through the same live markdown editor as event
// summaries. Geometry is stored in image fractions, so frames follow the
// picture through any zoom.
//
// Zoom / pan is shared by both modes: wheel zooms around the cursor, drag
// pans (edit mode pans with Ctrl or the middle button), double-click resets.

import { App, EventRef, Modal, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { MapEntry, MapOcclusion } from "./maps-format";
import { generateId } from "./id";
import { DbType, EntityEntry } from "./db-format";
import { EntityModal } from "./entity-modal";
import { LiveEditor, registerEscapeFirst } from "./live-editor";
import { DbColors, loadDbColors } from "./quiz-render";
import { QuizEntry, QuizResult, isQuizReady, reviewQuiz } from "./quiz";
import { nextReviewLabel, quizSchedule } from "./quiz-display";
import {
	positionBox,
	renderOcclusionAnswer,
	syncMapQuizzes,
} from "./map-occlusion";

type Mode = "review" | "edit";

const MIN_SCALE = 1;
const MAX_SCALE = 12;
// Frames smaller than this fraction on either axis are accidental clicks.
const MIN_FRAC = 0.005;

export class MapOcclusionViewer extends Modal {
	private map: MapEntry;
	private mode: Mode = "review";
	private scale = 1;
	private tx = 0;
	private ty = 0;
	private revealed = new Set<string>();
	private current = "";
	private selected = "";
	private quizzes = new Map<string, QuizEntry>();
	private dbColors: DbColors = new Map();
	private entities: EntityEntry[] = [];
	private types: DbType[] = [];
	private editor?: LiveEditor;
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
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("hl-occ-viewer-window");
		registerEscapeFirst(this.scope, () =>
			this.editor?.closeSuggestIfOpen() ?? false
		);
		this.scope.register([], "1", () => {
			this.rateCurrent("forgot");
			return false;
		});
		this.scope.register([], "2", () => {
			this.rateCurrent("remembered");
			return false;
		});
		this.dbColors = await loadDbColors(this.plugin);
		this.entities = [...(await this.plugin.store.readEntities()).values()];
		this.types = await this.plugin.store.readDbTypes();
		this.quizzes = await syncMapQuizzes(this.plugin, this.map);
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
		this.editor?.refreshDecorations();
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

	private indexOf(id: string): number {
		return this.map.occlusions.findIndex((o) => o.id === id);
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
		if (this.map.occlusions.length)
			head.createSpan({
				cls: "hl-occ-count",
				text:
					this.mode === "review"
						? `已揭开 ${this.revealed.size}/${this.map.occlusions.length}`
						: `${this.map.occlusions.length} 个遮罩`,
			});
		const spacer = head.createSpan({ cls: "hl-occ-head-space" });
		void spacer;
		const modeBtn = head.createEl("button", {
			cls: `hl-occ-mode-btn${this.mode === "edit" ? " is-active" : ""}`,
			text: this.mode === "edit" ? "完成标记" : "标记遮罩",
		});
		modeBtn.addEventListener("click", () => this.toggleMode());
		const zoomHint = head.createSpan({
			cls: "hl-occ-zoom-hint",
			text: "滚轮缩放 · 拖拽平移 · 双击复位",
		});
		void zoomHint;

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
		// The picture opens fully visible, centered inside the fixed window;
		// zooming starts from there. Re-renders keep the current view.
		const settle = (): void => {
			if (this.fitW) {
				img.style.width = `${this.fitW}px`;
				this.applyTransform();
			} else this.fitToWrap();
		};
		if (img.complete) window.setTimeout(settle, 0);
		else img.addEventListener("load", settle, { once: true });
		this.applyTransform();

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
		const box = this.stage.createDiv({ cls: "hl-occ-box" });
		positionBox(box, occ);
		this.boxEls.set(occ.id, box);
		this.paintBox(occ.id);
		if (this.mode === "edit") {
			const handle = box.createDiv({ cls: "hl-occ-handle" });
			void handle;
			const x = box.createDiv({ cls: "hl-occ-x", text: "×" });
			x.addEventListener("mousedown", (e) => e.stopPropagation());
			x.addEventListener("click", (e) => {
				e.stopPropagation();
				this.deleteOcclusion(occ.id);
			});
		}
	}

	private paintBox(id: string): void {
		const box = this.boxEls.get(id);
		if (!box) return;
		box.toggleClass("is-edit", this.mode === "edit");
		box.toggleClass(
			"is-revealed",
			this.mode === "review" && this.revealed.has(id)
		);
		box.toggleClass(
			"is-current",
			this.mode === "review"
				? this.current === id
				: this.selected === id
		);
	}

	private paintAllBoxes(): void {
		for (const id of this.boxEls.keys()) this.paintBox(id);
	}

	// ------------------------------------------------------------ side panel

	private paintSide(): void {
		this.side.empty();
		this.rowEls.clear();
		if (this.mode === "edit") {
			this.paintEditSide();
			return;
		}
		if (!this.map.occlusions.length) {
			this.side.createDiv({
				cls: "hl-occ-side-empty",
				text: "还没有遮罩。点「标记遮罩」在图上框选。",
			});
			return;
		}
		this.side.createDiv({ cls: "hl-occ-side-label", text: "答案" });
		const list = this.side.createDiv({ cls: "hl-occ-list" });
		this.map.occlusions.forEach((occ, i) => {
			const row = list.createDiv({ cls: "hl-occ-row" });
			this.rowEls.set(occ.id, row);
			const head = row.createDiv({ cls: "hl-occ-row-head" });
			head.createSpan({ cls: "hl-occ-row-num", text: String(i + 1) });
			if (this.revealed.has(occ.id)) {
				const body = row.createDiv({ cls: "hl-occ-row-answer" });
				renderOcclusionAnswer(
					this.plugin,
					occ.answer,
					body,
					this.dbColors
				);
			} else {
				row.addClass("is-hidden");
				head.createSpan({
					cls: "hl-occ-row-covered",
					text: "未揭开",
				});
			}
			row.toggleClass("is-current", this.current === occ.id);
			row.addEventListener("click", () => {
				if (this.revealed.has(occ.id)) this.setCurrent(occ.id);
				else this.reveal(occ.id);
			});
			row.addEventListener("mouseenter", () =>
				this.boxEls.get(occ.id)?.addClass("is-hover")
			);
			row.addEventListener("mouseleave", () =>
				this.boxEls.get(occ.id)?.removeClass("is-hover")
			);
			if (this.current === occ.id && this.revealed.has(occ.id))
				this.paintRating(row, occ);
		});
	}

	// 记得/不记得 for the current frame's quiz, mirroring the player wording.
	private paintRating(row: HTMLElement, occ: MapOcclusion): void {
		const quiz = this.quizzes.get(occ.id);
		if (!quiz) return;
		const bar = row.createDiv({ cls: "hl-occ-rate" });
		if (quiz.status === "mastered") {
			bar.createSpan({ cls: "hl-occ-rate-note", text: "已掌握" });
			return;
		}
		const schedule = quizSchedule(this.plugin.settings);
		if (!isQuizReady(quiz, new Date(), schedule)) {
			bar.createSpan({
				cls: "hl-occ-rate-note",
				text: `未到期 · ${nextReviewLabel(quiz, new Date(), schedule)}`,
			});
			return;
		}
		for (const [result, label, key] of [
			["forgot", "不记得", "1"],
			["remembered", "记得", "2"],
		] as [QuizResult, string, string][]) {
			const btn = bar.createEl("button", { cls: "hl-occ-rate-btn" });
			if (result === "remembered") btn.addClass("mod-cta");
			btn.setText(`${label} (${key})`);
			btn.addEventListener("click", () =>
				void this.rate(occ.id, result)
			);
		}
		const dots = bar.createSpan({ cls: "hl-occ-rate-dots" });
		const steps = this.plugin.settings.quizMasterySteps;
		for (let i = 0; i < steps; i++)
			dots.createSpan({
				cls:
					i < quiz.progress
						? "hl-player-dot is-on"
						: "hl-player-dot",
			});
	}

	private paintEditSide(): void {
		this.side.createDiv({
			cls: "hl-occ-side-hint",
			text: "在图上拖拽框选新遮罩；拖动移动，角柄缩放。",
		});
		const occ = this.selected ? this.occOf(this.selected) : undefined;
		if (!occ) {
			this.side.createDiv({
				cls: "hl-occ-side-empty",
				text: this.map.occlusions.length
					? "点击一个遮罩框来编辑答案。"
					: "还没有遮罩。",
			});
			return;
		}
		this.side.createDiv({
			cls: "hl-occ-side-label",
			text: `遮罩 ${this.indexOf(occ.id) + 1} 的答案`,
		});
		const editorEl = this.side.createDiv({
			cls: "hl-occ-editor hl-summary-editor",
		});
		this.editor?.destroy();
		this.editor = new LiveEditor(editorEl, {
			value: occ.answer,
			placeholder: "答案（markdown，支持 {db} 词条语法）…",
			onChange: (value) => {
				occ.answer = value;
				this.scheduleSave();
			},
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
				autoTrigger: () =>
					this.plugin.settings.completeAutoTrigger,
				lastToken: () => this.plugin.settings.completeLastToken,
			},
		});
		const del = this.side.createEl("button", {
			cls: "hl-occ-delete",
			text: "删除这个遮罩",
		});
		del.addEventListener("click", () => this.deleteOcclusion(occ.id));
	}

	// ---------------------------------------------------------------- review

	private reveal(id: string): void {
		if (this.mode !== "review") return;
		this.revealed.add(id);
		this.setCurrent(id);
	}

	private setCurrent(id: string): void {
		this.current = id;
		this.paintAllBoxes();
		this.paintSide();
		this.updateCount();
		this.rowEls
			.get(id)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}

	private updateCount(): void {
		const count = this.contentEl.querySelector(".hl-occ-count");
		if (count && this.mode === "review")
			count.setText(
				`已揭开 ${this.revealed.size}/${this.map.occlusions.length}`
			);
	}

	private rateCurrent(result: QuizResult): void {
		if (this.mode !== "review" || !this.current) return;
		if (!this.revealed.has(this.current)) return;
		const quiz = this.quizzes.get(this.current);
		if (!quiz || quiz.status !== "active") return;
		if (!isQuizReady(quiz, new Date(), quizSchedule(this.plugin.settings)))
			return;
		void this.rate(this.current, result);
	}

	private async rate(occId: string, result: QuizResult): Promise<void> {
		const quiz = this.quizzes.get(occId);
		if (!quiz) return;
		const updated = reviewQuiz(
			quiz,
			result,
			new Date(),
			quizSchedule(this.plugin.settings)
		);
		await this.plugin.store.upsertQuiz(updated);
		this.plugin.remindQuizWhenReady(updated);
		void this.plugin.refreshTimelines();
		this.quizzes.set(occId, updated);
		this.setCurrent(occId);
		// Nudge the next covered frame so a 20-frame map runs through in one
		// pass — the reveal itself stays a deliberate click.
		const next = this.map.occlusions.find(
			(o) => !this.revealed.has(o.id)
		);
		if (next) this.boxEls.get(next.id)?.addClass("is-next");
	}

	// ------------------------------------------------------------------ edit

	private toggleMode(): void {
		this.mode = this.mode === "review" ? "edit" : "review";
		this.selected = "";
		this.current = "";
		this.editor?.destroy();
		this.editor = undefined;
		this.render();
	}

	private deleteOcclusion(id: string): void {
		this.map.occlusions = this.map.occlusions.filter((o) => o.id !== id);
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
		this.quizzes = await syncMapQuizzes(this.plugin, this.map);
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
				if (this.scale === MIN_SCALE) {
					this.fitToWrap();
					return;
				}
				this.applyTransform();
			},
			{ passive: false }
		);
		wrap.addEventListener("dblclick", () => this.fitToWrap());
		wrap.addEventListener("mousedown", (e) => {
			if (e.button === 1 || (this.mode === "edit" && e.ctrlKey)) {
				this.startPan(e);
				return;
			}
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			const boxId = this.boxIdAt(target);
			if (this.mode === "review") {
				this.startReviewDrag(e, boxId);
				return;
			}
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

	// Review: drag pans, a near-still click on a frame reveals it.
	private startReviewDrag(e: MouseEvent, boxId: string): void {
		e.preventDefault();
		const sx = e.clientX - this.tx;
		const sy = e.clientY - this.ty;
		const ox = e.clientX;
		const oy = e.clientY;
		let moved = false;
		this.trackDrag(
			(ev) => {
				if (
					Math.abs(ev.clientX - ox) > 4 ||
					Math.abs(ev.clientY - oy) > 4
				)
					moved = true;
				if (!moved) return;
				this.tx = ev.clientX - sx;
				this.ty = ev.clientY - sy;
				this.applyTransform();
			},
			() => {
				if (!moved && boxId) this.reveal(boxId);
			}
		);
	}

	private startDraw(e: MouseEvent): void {
		const start = this.toFrac(e);
		if (!start) return;
		e.preventDefault();
		const ghost = this.stage.createDiv({
			cls: "hl-occ-box is-edit is-ghost",
		});
		const place = (a: { x: number; y: number }, b: { x: number; y: number }): void =>
			positionBox(ghost, {
				id: "",
				x: Math.min(a.x, b.x),
				y: Math.min(a.y, b.y),
				w: Math.abs(a.x - b.x),
				h: Math.abs(a.y - b.y),
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
					this.selected = "";
					this.paintAllBoxes();
					this.paintSide();
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
		if (this.selected !== id) {
			this.selected = id;
			this.paintAllBoxes();
			this.paintSide();
		}
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
			this.editor?.refreshDecorations();
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
