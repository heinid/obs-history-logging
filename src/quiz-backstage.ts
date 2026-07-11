import {
	FuzzySuggestModal,
	MarkdownRenderer,
	Notice,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import {
	QuizEntry,
	QuizStatus,
	pauseQuiz,
	resumeQuiz,
	reviveQuiz,
} from "./quiz";
import {
	nextReviewLabel,
	quizQuestion,
} from "./quiz-display";
import { QuizPracticeModal } from "./quiz-modal";
import { describeYear, parseYearTag } from "./year-tag";
import { ConfirmModal } from "./name-modal";
import { stripDbMarkers } from "./db-marker";

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
	state: QuizBackstageState,
	onChanged: () => Promise<void>
): void {
	const bar = host.createDiv({ cls: "hl-eb-bar hl-quiz-backstage-bar" });
	const search = bar.createEl("input", {
		cls: "hl-eb-search",
		type: "search",
		placeholder: "Search quizzes…",
	});
	search.value = state.query;
	const status = bar.createEl("select", { cls: "dropdown hl-eb-select" });
	for (const [value, label] of [
		["all", "All"],
		["active", "Learning"],
		["paused", "Paused"],
		["mastered", "Mastered"],
		["retired", "Retired"],
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
			return `${quiz.question} ${quiz.answer} ${quiz.hint} ${
				event?.summary ?? ""
			} ${event?.tag ?? ""}`
				.toLowerCase()
				.includes(query);
		});
		host.querySelector(".hl-quiz-backstage-count")?.remove();
		const count = createDiv({
			cls: "hl-eb-count hl-quiz-backstage-count",
			text: `${filtered.length} of ${quizzes.length} quizzes`,
		});
		list.insertAdjacentElement("beforebegin", count);

		const groups = new Map<string, QuizEntry[]>();
		for (const quiz of filtered) {
			const group = groups.get(quiz.sourceEvId) ?? [];
			group.push(quiz);
			groups.set(quiz.sourceEvId, group);
		}
		if (!groups.size) {
			list.createDiv({
				cls: "hl-eb-empty",
				text: quizzes.length
					? "No quizzes match."
					: "No quizzes yet. Open an event's ⌛ menu to create one.",
			});
			return;
		}
		for (const [evId, group] of groups) {
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
					: "Orphaned source",
			});
			const summary = head.createDiv({ cls: "hl-quiz-event-summary" });
			if (event)
				void MarkdownRenderer.render(
					plugin.app,
					stripDbMarkers(event.summary),
					summary,
					"",
					plugin
				);
			else summary.setText(evId);
			if (group.some((quiz) => quiz.status === "mastered")) {
				const revive = head.createEl("button", {
					text: "Learn mastered again",
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
				renderQuizRow(section, plugin, quiz, event, events, onChanged);
		}
	};

	search.addEventListener("input", paint);
	status.addEventListener("change", paint);
	paint();
}

function renderQuizRow(
	host: HTMLElement,
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	event: EventEntry | undefined,
	events: Map<string, EventEntry>,
	onChanged: () => Promise<void>
): void {
	const row = host.createDiv({ cls: "hl-quiz-backstage-row" });
	const content = row.createDiv({ cls: "hl-quiz-backstage-content" });
	const question = content.createDiv({ cls: "hl-quiz-backstage-question" });
	void MarkdownRenderer.render(
		plugin.app,
		stripDbMarkers(quizQuestion(quiz, event)),
		question,
		"",
		plugin
	);
	content.createDiv({
		cls: "hl-quiz-manage-meta",
		text: `${quiz.kind === "qa" ? "Q&A" : quiz.kind} · ${
			quiz.status
		} · Mastery ${quiz.progress}/${
			plugin.settings.quizMasterySteps
		} · ${nextReviewLabel(quiz)} · ${
			quiz.attempts.length
		} attempts · ${quiz.cycles.filter((cycle) => cycle.completedAt).length} cycles`,
	});

	const actions = row.createDiv({ cls: "hl-quiz-backstage-actions" });
	const practice = actions.createEl("button", { text: "Practice" });
	practice.disabled = quiz.status !== "active";
	practice.addEventListener("click", () =>
		new QuizPracticeModal(plugin.app, plugin, quiz.id).open()
	);
	if (event) {
		const edit = actions.createEl("button", { cls: "hl-icon-btn" });
		setIcon(edit, "pencil");
		edit.setAttr("aria-label", "Edit this quiz");
		edit.addEventListener("click", () =>
			plugin.openQuizManager(
				quiz.sourceEvId,
				event.tag ?? "",
				"",
				undefined,
				quiz.id
			)
		);
	} else {
		const rebind = actions.createEl("button", { text: "Rebind" });
		rebind.addEventListener("click", () =>
			new RebindQuizModal(plugin, quiz, events, onChanged).open()
		);
	}
	const state = actions.createEl("button", {
		text:
			quiz.status === "mastered"
				? "Learn again"
				: quiz.status === "paused"
				? "Resume learning"
				: "Pause learning",
	});
	state.disabled = quiz.status === "retired";
	state.addEventListener("click", () =>
		void updateQuiz(
			plugin,
			quiz.status === "mastered"
				? reviveQuiz(quiz)
				: quiz.status === "paused"
				? resumeQuiz(quiz)
				: pauseQuiz(quiz),
			onChanged
		)
	);
	const remove = actions.createEl("button", { cls: "hl-icon-btn" });
	setIcon(remove, "trash-2");
	remove.setAttr("aria-label", "Delete quiz");
	remove.addEventListener("click", () =>
		new ConfirmModal(
			plugin.app,
			"Delete quiz",
			"Delete this quiz and all of its attempt history?",
			"Delete",
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
		this.setPlaceholder("Rebind quiz to an event…");
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
			new Notice("Quiz source rebound.");
		})();
	}
}
