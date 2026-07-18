import { App, Modal } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import { QuizEntry, QuizResult, isQuizReady, reviewQuiz } from "./quiz";
import {
	clozeRevealsInline,
	nextReviewLabel,
	quizAnswer,
	quizQuestion,
	quizSchedule,
} from "./quiz-display";
import { DbColors, loadDbColors, renderQuizText } from "./quiz-render";
import { renderMapExamStage } from "./map-occlusion";

export class QuizSessionModal extends Modal {
	private quizzes: QuizEntry[] = [];
	private events = new Map<string, EventEntry>();
	private index = 0;
	private revealed = false;
	private results: Record<QuizResult, number> = {
		remembered: 0,
		fuzzy: 0,
		forgot: 0,
	};
	private weakIds = new Set<string>();
	private dbColors: DbColors = new Map();

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private quizIds: string[]
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.plugin.modalStash.track(this);
		const [allQuizzes, events, colors] = await Promise.all([
			this.plugin.store.readQuizzes(),
			this.plugin.store.readEvents(),
			loadDbColors(this.plugin),
		]);
		this.dbColors = colors;
		this.events = events;
		this.quizzes = shuffle(
			this.quizIds
				.map((id) => allQuizzes.get(id))
				.filter((quiz): quiz is QuizEntry => !!quiz)
		);
		this.render();
	}

	// Reload events/colors but keep the session position and reveal state.
	async onStashRestore(): Promise<void> {
		const [events, colors] = await Promise.all([
			this.plugin.store.readEvents(),
			loadDbColors(this.plugin),
		]);
		this.events = events;
		this.dbColors = colors;
		this.render();
	}

	private render(): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-quiz-session");
		if (!this.quizzes.length || this.index >= this.quizzes.length) {
			this.renderResults(host);
			return;
		}
		const quiz = this.quizzes[this.index];
		const event = this.events.get(quiz.sourceEvId);
		const schedule = quizSchedule(this.plugin.settings);
		const ready = isQuizReady(quiz, new Date(), schedule);
		// Map quizzes get the exam layout: the zoomable map fills the window
		// and the card side (question, answer, actions) sits in a side panel.
		const isMap = quiz.kind === "map";
		this.modalEl.toggleClass("hl-map-exam-window", isMap);
		host.toggleClass("hl-map-exam", isMap);

		const head = host.createDiv({ cls: "hl-quiz-session-head" });
		head.createSpan({
			text: `第 ${this.index + 1} 题，共 ${this.quizzes.length} 题`,
		});

		let main = host;
		if (isMap) {
			const body = host.createDiv({ cls: "hl-map-exam-body" });
			const stageHost = body.createDiv({ cls: "hl-occ-stage-host" });
			void renderMapExamStage(this.plugin, quiz, stageHost, this.revealed);
			main = body.createDiv({ cls: "hl-map-exam-side" });
		}

		const question = main.createDiv({ cls: "hl-quiz-practice-question" });
		renderQuizText(
			this.plugin,
			quizQuestion(quiz, event, this.revealed),
			question,
			this.dbColors
		);
		main.createDiv({
			cls: "hl-quiz-session-mastery",
			text: `掌握 ${quiz.progress}/${this.plugin.settings.quizMasterySteps}${
				ready ? "" : ` · ${nextReviewLabel(quiz, new Date(), schedule)}`
			}`,
		});
		if (!this.revealed) {
			if (quiz.hint) {
				const details = main.createEl("details", { cls: "hl-quiz-hint" });
				details.createEl("summary", { text: "提示" });
				const hint = details.createDiv();
				renderQuizText(this.plugin, quiz.hint, hint, this.dbColors);
			}
			const show = main.createEl("button", {
				cls: "mod-cta hl-quiz-show-answer",
				text: "显示答案",
			});
			show.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
			return;
		}

		if (!clozeRevealsInline(quiz)) {
			const answer = main.createDiv({ cls: "hl-quiz-practice-answer" });
			renderQuizText(
				this.plugin,
				quizAnswer(quiz, event),
				answer,
				this.dbColors
			);
		}
		const actions = main.createDiv({ cls: "hl-quiz-review-actions" });
		if (!ready) {
			actions.createSpan({
				cls: "hl-quiz-wait-note",
				text: nextReviewLabel(quiz, new Date(), schedule),
			});
			const next = actions.createEl("button", {
				cls: "mod-cta",
				text: "下一题",
			});
			next.addEventListener("click", () => {
				this.index++;
				this.revealed = false;
				this.render();
			});
			return;
		}
		for (const [result, label] of [
			["forgot", "不记得"],
			["remembered", "记得"],
		] as [QuizResult, string][]) {
			const button = actions.createEl("button", { text: label });
			if (result === "remembered") button.addClass("mod-cta");
			button.setAttr(
				"aria-label",
				result === "forgot"
					? "不记得：掌握退一级并进入等待"
					: "记得：掌握进一级"
			);
			button.addEventListener("click", () => void this.rate(quiz, result));
		}
	}

	private async rate(quiz: QuizEntry, result: QuizResult): Promise<void> {
		const updated = reviewQuiz(
			quiz,
			result,
			new Date(),
			quizSchedule(this.plugin.settings)
		);
		await this.plugin.store.upsertQuiz(updated);
		this.plugin.remindQuizWhenReady(updated);
		this.results[result]++;
		if (result === "remembered") this.weakIds.delete(quiz.id);
		else this.weakIds.add(quiz.id);
		this.quizzes[this.index] = updated;
		this.index++;
		this.revealed = false;
		this.render();
	}

	private renderResults(host: HTMLElement): void {
		host.createEl("h2", { text: "练习完成" });
		const summary = host.createDiv({ cls: "hl-quiz-session-results" });
		summary.createDiv({ text: `记得 ${this.results.remembered}` });
		summary.createDiv({ text: `不记得 ${this.results.forgot}` });
		if (this.weakIds.size) {
			const retry = host.createEl("button", {
				text: `重练 ${this.weakIds.size} 道题`,
			});
			retry.addEventListener("click", () => this.retestWeak());
		}
		const done = host.createEl("button", { cls: "mod-cta", text: "完成" });
		done.addEventListener("click", () => this.close());
	}

	private retestWeak(): void {
		this.quizzes = shuffle(
			this.quizzes.filter((quiz) => this.weakIds.has(quiz.id))
		);
		this.weakIds.clear();
		this.index = 0;
		this.revealed = false;
		this.results = { remembered: 0, fuzzy: 0, forgot: 0 };
		this.render();
	}

	onClose(): void {
		this.plugin.modalStash.untrack(this);
		void this.plugin.refreshTimelines();
		this.contentEl.empty();
	}
}

function shuffle<T>(items: T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}
