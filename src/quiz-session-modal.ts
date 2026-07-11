import { App, MarkdownRenderer, Modal } from "obsidian";
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

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private quizIds: string[]
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const [allQuizzes, events] = await Promise.all([
			this.plugin.store.readQuizzes(),
			this.plugin.store.readEvents(),
		]);
		this.events = events;
		this.quizzes = shuffle(
			this.quizIds
				.map((id) => allQuizzes.get(id))
				.filter((quiz): quiz is QuizEntry => !!quiz)
		);
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
		const ready = isQuizReady(quiz);

		const head = host.createDiv({ cls: "hl-quiz-session-head" });
		head.createSpan({
			text: `第 ${this.index + 1} 题，共 ${this.quizzes.length} 题`,
		});

		const question = host.createDiv({ cls: "hl-quiz-practice-question" });
		void MarkdownRenderer.render(
			this.app,
			quizQuestion(quiz, event, this.revealed),
			question,
			"",
			this.plugin
		);
		host.createDiv({
			cls: "hl-quiz-session-mastery",
			text: `掌握 ${quiz.progress}/${
				this.plugin.settings.quizMasterySteps
			}${ready ? "" : ` · ${nextReviewLabel(quiz)}`}`,
		});
		if (!this.revealed) {
			if (!ready)
				host.createDiv({
					cls: "hl-quiz-early-note",
					text: "提前练习答对不会推进掌握。",
				});
			if (quiz.hint) {
				const details = host.createEl("details", { cls: "hl-quiz-hint" });
				details.createEl("summary", { text: "提示" });
				const hint = details.createDiv();
				void MarkdownRenderer.render(
					this.app,
					quiz.hint,
					hint,
					"",
					this.plugin
				);
			}
			const show = host.createEl("button", {
				cls: "mod-cta hl-quiz-show-answer",
				text: ready ? "显示答案" : "立即练习",
			});
			show.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
			return;
		}

		if (!clozeRevealsInline(quiz)) {
			const answer = host.createDiv({ cls: "hl-quiz-practice-answer" });
			void MarkdownRenderer.render(
				this.app,
				quizAnswer(quiz, event),
				answer,
				"",
				this.plugin
			);
		}
		const actions = host.createDiv({ cls: "hl-quiz-review-actions" });
		for (const [result, label] of [
			["forgot", "不记得"],
			["remembered", "记得"],
		] as [QuizResult, string][]) {
			const button = actions.createEl("button", { text: label });
			if (result === "remembered") button.addClass("mod-cta");
			button.setAttr(
				"aria-label",
				result === "forgot"
					? "不记得：掌握退一级并在短间隔后重试"
					: "记得：到达练习时间时掌握进一级"
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
