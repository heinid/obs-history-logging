import { FuzzySuggestModal, Notice, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import { MapEntry } from "./maps-format";
import {
	QuizEntry,
	QuizStatus,
	reviveQuiz,
} from "./quiz";
import {
	nextReviewLabel,
	quizQuestion,
	quizSchedule,
} from "./quiz-display";
import { QuizPracticeModal } from "./quiz-modal";
import { describeYear, parseYearTag } from "./year-tag";
import { ConfirmModal } from "./name-modal";
import { DbColors, renderQuizText } from "./quiz-render";

export type QuizBackstageStatus = "all" | QuizStatus;

export interface QuizBackstageState {
	query: string;
	status: QuizBackstageStatus;
}

export function renderQuizBackstage(
	host: HTMLElement,
	plugin: HistoryLoggingPlugin,
	quizzes: QuizEntry[],
	events: Map<string, EventEntry>,
	dbColors: DbColors,
	state: QuizBackstageState,
	onChanged: () => Promise<void>,
	maps: Map<string, MapEntry> = new Map()
): void {
	const bar = host.createDiv({ cls: "hl-eb-bar hl-quiz-backstage-bar" });
	const search = bar.createEl("input", {
		cls: "hl-eb-search",
		type: "search",
		placeholder: "搜索 Quiz、答案或事件…",
	});
	search.value = state.query;
	const status = bar.createEl("select", { cls: "dropdown hl-eb-select" });
	for (const [value, label] of [
		["all", "全部"],
		["active", "在学"],
		["mastered", "学过"],
	] as [QuizBackstageStatus, string][])
		status.createEl("option", { value, text: label });
	status.value = state.status;
	const list = host.createDiv({ cls: "hl-quiz-backstage-list" });

	const paint = (): void => {
		list.empty();
		state.query = search.value;
		state.status = status.value as QuizBackstageStatus;
		const query = state.query.trim().toLowerCase();
		const filtered = quizzes.filter((quiz) => {
			if (state.status !== "all" && quiz.status !== state.status) return false;
			if (!query) return true;
			const event = events.get(quiz.sourceEvId);
			const map = quiz.sourceMapId
				? maps.get(quiz.sourceMapId)
				: undefined;
			return `${quiz.question} ${quiz.answer} ${quiz.hint} ${
				event?.summary ?? ""
			} ${event?.tag ?? ""} ${map?.title ?? ""}`
				.toLowerCase()
				.includes(query);
		});
		host.querySelector(".hl-quiz-backstage-count")?.remove();
		const count = createDiv({
			cls: "hl-eb-count hl-quiz-backstage-count",
			text: `${filtered.length} / ${quizzes.length} 个 Quiz`,
		});
		list.insertAdjacentElement("beforebegin", count);

		const groups = new Map<string, QuizEntry[]>();
		for (const quiz of filtered) {
			const key =
				quiz.kind === "map" && quiz.sourceMapId
					? `map:${quiz.sourceMapId}`
					: quiz.sourceEvId;
			const group = groups.get(key) ?? [];
			group.push(quiz);
			groups.set(key, group);
		}
		if (!groups.size) {
			list.createDiv({
				cls: "hl-eb-empty",
				text: quizzes.length
					? "没有符合条件的 Quiz。"
					: "还没有 Quiz。请从事件的 ⌛ 菜单创建。",
			});
			return;
		}
		for (const [evId, group] of groups) {
			if (evId.startsWith("map:")) {
				renderMapGroup(
					list,
					plugin,
					evId.slice(4),
					group,
					maps,
					events,
					dbColors,
					onChanged
				);
				continue;
			}
			const event = events.get(evId);
			const section = list.createDiv({ cls: "hl-quiz-event-group" });
			const head = section.createDiv({ cls: "hl-quiz-event-head" });
			const decoded = event?.tag ? parseYearTag(event.tag) : null;
			head.createSpan({
				cls: "hl-quiz-event-year",
				text: event
					? decoded
						? describeYear(decoded)
						: event.tag ?? evId
					: "来源事件已不存在",
			});
			const summary = head.createDiv({ cls: "hl-quiz-event-summary" });
			if (event)
				renderQuizText(plugin, event.summary, summary, dbColors);
			else summary.setText(evId);
			if (event) {
				const open = head.createEl("button", {
					cls: "hl-icon-btn hl-quiz-event-open",
				});
				setIcon(open, "hourglass");
				open.setAttr("aria-label", "编辑事件总结");
				open.addEventListener("click", () =>
					plugin.openSummary(evId, event.tag ?? "", () => void onChanged())
				);
			}
			if (group.some((quiz) => quiz.status === "mastered")) {
				const revive = head.createEl("button", {
					text: "重新学习已掌握题",
				});
				revive.addEventListener("click", () =>
					void (async () => {
						const all = await plugin.store.readQuizzes();
						for (const quiz of group)
							if (quiz.status === "mastered")
								all.set(quiz.id, reviveQuiz(quiz));
						await plugin.store.writeQuizzes(all);
						await plugin.refreshTimelines();
						await onChanged();
					})()
				);
			}
			for (const quiz of group)
				renderQuizRow(
					section,
					plugin,
					quiz,
					event,
					events,
					dbColors,
					onChanged
				);
		}
	};

	search.addEventListener("input", paint);
	status.addEventListener("change", paint);
	paint();
}

// A map's occlusion quizzes as one section: 🗺 title in the head opens the
// viewer, and rows lose the rebind action (the frame is the binding).
function renderMapGroup(
	list: HTMLElement,
	plugin: HistoryLoggingPlugin,
	mapId: string,
	group: QuizEntry[],
	maps: Map<string, MapEntry>,
	events: Map<string, EventEntry>,
	dbColors: DbColors,
	onChanged: () => Promise<void>
): void {
	const map = maps.get(mapId);
	const section = list.createDiv({ cls: "hl-quiz-event-group" });
	const head = section.createDiv({ cls: "hl-quiz-event-head" });
	head.createSpan({
		cls: "hl-quiz-event-year",
		text: "🗺",
	});
	const title = head.createDiv({ cls: "hl-quiz-event-summary" });
	title.setText(map ? map.title || map.image : "来源地图已不存在");
	if (map) {
		const open = head.createEl("button", {
			cls: "hl-icon-btn hl-quiz-event-open",
		});
		setIcon(open, "map");
		open.setAttr("aria-label", "打开地图查看器");
		open.addEventListener("click", () =>
			void plugin.openMapViewer(map.id, () => void onChanged())
		);
	}
	if (group.some((quiz) => quiz.status === "mastered")) {
		const revive = head.createEl("button", { text: "重新学习已掌握题" });
		revive.addEventListener("click", () =>
			void (async () => {
				const all = await plugin.store.readQuizzes();
				for (const quiz of group)
					if (quiz.status === "mastered")
						all.set(quiz.id, reviveQuiz(quiz));
				await plugin.store.writeQuizzes(all);
				await plugin.refreshTimelines();
				await onChanged();
			})()
		);
	}
	for (const quiz of group)
		renderQuizRow(section, plugin, quiz, undefined, events, dbColors, onChanged, !!map);
}

function renderQuizRow(
	host: HTMLElement,
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	event: EventEntry | undefined,
	events: Map<string, EventEntry>,
	dbColors: DbColors,
	onChanged: () => Promise<void>,
	mapBound = false
): void {
	const row = host.createDiv({ cls: "hl-quiz-backstage-row" });
	const content = row.createDiv({ cls: "hl-quiz-backstage-content" });
	const question = content.createDiv({ cls: "hl-quiz-backstage-question" });
	renderQuizText(plugin, quizQuestion(quiz, event), question, dbColors);
	const reviewLabel = nextReviewLabel(
		quiz,
		new Date(),
		quizSchedule(plugin.settings)
	);
	content.createDiv({
		cls: "hl-quiz-manage-meta",
		text: `${quizKindLabel(quiz)} · ${
			quiz.status === "mastered" ? "学过" : "在学"
		} · 掌握 ${quiz.progress}/${plugin.settings.quizMasterySteps}${
			reviewLabel ? ` · ${reviewLabel}` : ""
		}`,
	});

	const actions = row.createDiv({ cls: "hl-quiz-backstage-actions" });
	const practice = actions.createEl("button", { cls: "hl-icon-btn" });
	setIcon(practice, "brain");
	practice.setAttr("aria-label", "练习");
	practice.disabled = quiz.status !== "active";
	practice.addEventListener("click", () =>
		new QuizPracticeModal(plugin.app, plugin, quiz.id).open()
	);
	if (event) {
		const edit = actions.createEl("button", { cls: "hl-icon-btn" });
		setIcon(edit, "pencil");
		edit.setAttr("aria-label", "编辑这个 Quiz");
		edit.addEventListener("click", () =>
			plugin.openQuizManager(
				quiz.sourceEvId,
				event.tag ?? "",
				"",
				undefined,
				quiz.id
			)
		);
	} else if (!mapBound && quiz.kind !== "map") {
		const rebind = actions.createEl("button", { text: "重新绑定" });
		rebind.addEventListener("click", () =>
			new RebindQuizModal(plugin, quiz, events, onChanged).open()
		);
	}
	if (quiz.status === "mastered") {
		const relearn = actions.createEl("button", { text: "重新学习" });
		relearn.addEventListener("click", () =>
			void updateQuiz(plugin, reviveQuiz(quiz), onChanged)
		);
	}
	const remove = actions.createEl("button", { cls: "hl-icon-btn" });
	setIcon(remove, "trash-2");
	remove.setAttr("aria-label", "删除这个 Quiz");
	remove.addEventListener("click", () =>
		new ConfirmModal(
			plugin.app,
			"删除 Quiz",
			"删除这个 Quiz 及其全部练习记录？",
			"删除",
			() =>
				void (async () => {
					await plugin.store.removeQuiz(quiz.id);
					await plugin.refreshTimelines();
					await onChanged();
				})()
		).open()
	);
}

async function updateQuiz(
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	onChanged: () => Promise<void>
): Promise<void> {
	await plugin.store.upsertQuiz(quiz);
	await plugin.refreshTimelines();
	await onChanged();
}

class RebindQuizModal extends FuzzySuggestModal<EventEntry> {
	private entries: EventEntry[];

	constructor(
		private plugin: HistoryLoggingPlugin,
		private quiz: QuizEntry,
		events: Map<string, EventEntry>,
		private onChanged: () => Promise<void>
	) {
		super(plugin.app);
		this.entries = [...events.values()];
		this.setPlaceholder("重新绑定 Quiz 的来源事件…");
	}

	getItems(): EventEntry[] {
		return this.entries;
	}

	getItemText(event: EventEntry): string {
		const decoded = event.tag ? parseYearTag(event.tag) : null;
		const year = decoded ? describeYear(decoded) : event.tag ?? "";
		return `${year} — ${event.summary.replace(/\s+/g, " ").trim()}`;
	}

	onChooseItem(event: EventEntry): void {
		void (async () => {
			await this.plugin.store.upsertQuiz({
				...this.quiz,
				sourceEvId: event.id,
				updated: new Date().toISOString(),
			});
			await this.plugin.refreshTimelines();
			await this.onChanged();
			new Notice("Quiz 已重新绑定来源事件。");
		})();
	}
}

function quizKindLabel(quiz: QuizEntry): string {
	if (quiz.kind === "year") return "Year";
	if (quiz.kind === "cloze") return "Cloze";
	if (quiz.kind === "map") return "地图";
	return "Q&A";
}
