// Map occlusion quizzes: one quiz entry (kind "map") per occlusion frame,
// scored by the same mastery loop as every other quiz. The map entry is the
// source of truth for geometry and answer text; syncMapQuizzes keeps the
// quizzes.md rows mirroring it (create for new frames, refresh text, drop
// rows whose frame is gone — their attempt history goes with them).

import { App, Modal, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { MapEntry, MapOcclusion } from "./maps-format";
import { QuizEntry } from "./quiz";
import { generateId } from "./id";
import { DbColors, renderQuizText } from "./quiz-render";
import { MapStage } from "./map-stage";

export function mapQuizQuestion(
	map: MapEntry,
	occ: MapOcclusion,
	index: number
): string {
	return (
		occ.question.trim() ||
		`🗺 ${map.title || map.image} · 遮罩 ${index + 1}`
	);
}

// Mirror a map's occlusion frames into quizzes.md. Returns occlusionId →
// quiz for the frames that now have one.
export async function syncMapQuizzes(
	plugin: HistoryLoggingPlugin,
	map: MapEntry
): Promise<Map<string, QuizEntry>> {
	const all = await plugin.store.readQuizzes();
	const byOcc = new Map<string, QuizEntry>();
	for (const quiz of all.values())
		if (quiz.kind === "map" && quiz.sourceMapId === map.id && quiz.occlusionId)
			byOcc.set(quiz.occlusionId, quiz);

	const now = new Date().toISOString();
	const alive = new Set(map.occlusions.map((o) => o.id));
	let dirty = false;

	for (const [occId, quiz] of byOcc)
		if (!alive.has(occId)) {
			all.delete(quiz.id);
			byOcc.delete(occId);
			dirty = true;
		}

	map.occlusions.forEach((occ, i) => {
		const question = mapQuizQuestion(map, occ, i);
		const hint = occ.hint.trim();
		const existing = byOcc.get(occ.id);
		if (existing) {
			if (
				existing.question !== question ||
				existing.answer !== occ.answer ||
				existing.hint !== hint
			) {
				const updated = {
					...existing,
					question,
					answer: occ.answer,
					hint,
					updated: now,
				};
				all.set(updated.id, updated);
				byOcc.set(occ.id, updated);
				dirty = true;
			}
			return;
		}
		const quiz: QuizEntry = {
			id: generateId((id) => all.has(id)),
			sourceEvId: "",
			sourceMapId: map.id,
			occlusionId: occ.id,
			kind: "map",
			status: "active",
			progress: 0,
			created: now,
			updated: now,
			question,
			answer: occ.answer,
			hint,
			attempts: [],
			cycles: [{ startedAt: now }],
		};
		all.set(quiz.id, quiz);
		byOcc.set(occ.id, quiz);
		dirty = true;
	});

	if (dirty) {
		await plugin.store.writeQuizzes(all);
		await plugin.refreshTimelines();
	}
	return byOcc;
}

function resolveMapImage(
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	map: MapEntry | undefined,
	host: HTMLElement
): TFile | null {
	if (!map) {
		host.createDiv({ cls: "hl-empty", text: "来源地图已不存在。" });
		return null;
	}
	const file = plugin.app.metadataCache.getFirstLinkpathDest(map.image, "");
	if (!(file instanceof TFile)) {
		host.createDiv({ cls: "hl-empty", text: `找不到图片：${map.image}` });
		return null;
	}
	return file;
}

function buildBoxes(
	stage: HTMLElement,
	map: MapEntry,
	quiz: QuizEntry,
	revealed: boolean
): void {
	for (const occ of map.occlusions) {
		const box = stage.createDiv({ cls: "hl-occ-box" });
		positionBox(box, occ);
		if (occ.id === quiz.occlusionId) {
			box.addClass("is-asked");
			if (revealed) box.addClass("is-revealed");
		}
	}
}

// Inline question surface of a map quiz (deck player card): the map with
// every frame covered; the asked frame is accented, and turns transparent
// on reveal. Double-click opens the zoomable full-size view. The answer
// text renders separately through the caller's normal answer slot.
export async function renderMapQuizSurface(
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	host: HTMLElement,
	colors: DbColors,
	revealed: boolean
): Promise<void> {
	const maps = await plugin.store.readMaps();
	const map = quiz.sourceMapId ? maps.get(quiz.sourceMapId) : undefined;
	const file = resolveMapImage(plugin, quiz, map, host);
	if (!map || !file) return;
	const stage = host.createDiv({ cls: "hl-mq-stage" });
	const img = stage.createEl("img", { cls: "hl-mq-img" });
	img.src = plugin.app.vault.getResourcePath(file);
	img.draggable = false;
	buildBoxes(stage, map, quiz, revealed);
	stage.addEventListener("dblclick", () => {
		new MapZoomModal(plugin.app, plugin, quiz, revealed).open();
	});
}

export interface MapExamHeaderOptions {
	// The map-list entry hides the source name (the user is already in that
	// map's context); every other entry shows it.
	showSource: boolean;
	positionLabel?: string;
	coolingLabel?: string;
	colors: DbColors;
}

// The "lintel" header of the immersive map exam: a solid bar across the
// top of the window. Kicker line = source map (optional) / position /
// mastery dots; the main line only appears when the frame has a custom
// question. The container is created synchronously so it keeps its place
// above the stage; the content fills in once the map is read.
export function renderMapExamHeader(
	plugin: HistoryLoggingPlugin,
	host: HTMLElement,
	quiz: QuizEntry,
	opts: MapExamHeaderOptions
): void {
	const header = host.createDiv({ cls: "hl-map-exam-header" });
	void (async () => {
		const maps = await plugin.store.readMaps();
		const map = quiz.sourceMapId ? maps.get(quiz.sourceMapId) : undefined;
		const occ = map?.occlusions.find((o) => o.id === quiz.occlusionId);
		const kicker = header.createDiv({ cls: "hl-map-exam-kicker" });
		if (opts.showSource)
			kicker.createSpan({
				cls: "hl-map-exam-source",
				text: map?.title?.trim() || "未命名地图",
			});
		if (opts.positionLabel) kicker.createSpan({ text: opts.positionLabel });
		const dots = kicker.createSpan({ cls: "hl-map-exam-dots" });
		const steps = plugin.settings.quizMasterySteps;
		for (let i = 0; i < steps; i++)
			dots.createSpan({
				cls: `hl-map-exam-dot${i < quiz.progress ? " is-on" : ""}`,
			});
		if (quiz.status === "mastered") kicker.createSpan({ text: "学过" });
		if (opts.coolingLabel)
			kicker.createSpan({
				cls: "hl-quiz-cooling",
				text: opts.coolingLabel,
			});
		const custom = occ?.question.trim();
		if (custom) {
			const question = header.createDiv({ cls: "hl-map-exam-question" });
			renderQuizText(plugin, custom, question, opts.colors);
		}
	})();
}

// Zoomable exam stage of a map quiz: same frame semantics as the inline
// surface, on the shared pan/zoom picture stage. Used by the map exam
// layout in the practice/reminder/session modals and by MapZoomModal.
export async function renderMapExamStage(
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	host: HTMLElement,
	revealed: boolean,
	focusAsked = false
): Promise<void> {
	const maps = await plugin.store.readMaps();
	const map = quiz.sourceMapId ? maps.get(quiz.sourceMapId) : undefined;
	const file = resolveMapImage(plugin, quiz, map, host);
	if (!map || !file) return;
	const stage = new MapStage(host, plugin.app.vault.getResourcePath(file));
	stage.stage.addClass("hl-mq-exam-stage");
	buildBoxes(stage.stage, map, quiz, revealed);
	const asked = map.occlusions.find((o) => o.id === quiz.occlusionId);
	if (focusAsked && asked) stage.focusOn(asked);
	stage.wrap.createDiv({
		cls: "hl-occ-nav-hint",
		text: "拖拽平移 · 滚轮缩放 · 双击看全图",
	});
}

// Read-only full-size view of a map quiz, opened by double-clicking the
// inline surface on a player card. The reveal state follows the card side.
export class MapZoomModal extends Modal {
	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private quiz: QuizEntry,
		private revealed: boolean
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("hl-map-zoom-window");
		this.contentEl.addClass("hl-map-zoom");
		const host = this.contentEl.createDiv({ cls: "hl-occ-stage-host" });
		void renderMapExamStage(this.plugin, this.quiz, host, this.revealed);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function positionBox(box: HTMLElement, occ: MapOcclusion): void {
	box.style.left = `${occ.x * 100}%`;
	box.style.top = `${occ.y * 100}%`;
	box.style.width = `${occ.w * 100}%`;
	box.style.height = `${occ.h * 100}%`;
}

