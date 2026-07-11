import { App, MarkdownRenderer, Modal } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import { QuizEntry, QuizResult, isQuizReady, reviewQuiz } from "./quiz";
import {
	clozeRevealsInline,
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
			text: `Question ${this.index + 1} of ${this.quizzes.length}`,
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
			text: `Mastery ${quiz.progress}/${
				this.plugin.settings.quizMasterySteps
			} · ${ready ? "Ready" : "Cooling down"}`,
		});
		if (!this.revealed) {
			if (!ready)
				host.createDiv({
					cls: "hl-quiz-early-note",
					text: "Cooling down: remembered will not advance mastery.",
				});
			if (quiz.hint) {
				const details = host.createEl("details", { cls: "hl-quiz-hint" });
				details.createEl("summary", { text: "Hint" });
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
				text: ready ? "Show answer" : "Practice now",
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
			["forgot", "Didn't recall"],
			["fuzzy", "Partly recalled"],
			["remembered", "Recalled"],
		] as [QuizResult, string][]) {
			const button = actions.createEl("button", { text: label });
			if (result === "remembered") button.addClass("mod-cta");
			button.setAttr(
				"aria-label",
				result === "forgot"
					? "Didn't recall — move mastery back one step"
					: result === "fuzzy"
					? "Partly recalled — keep mastery and retry soon"
					: "Recalled — advance mastery when ready"
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
		host.createEl("h2", { text: "Practice complete" });
		const summary = host.createDiv({ cls: "hl-quiz-session-results" });
		summary.createDiv({ text: `Recalled ${this.results.remembered}` });
		summary.createDiv({ text: `Partly recalled ${this.results.fuzzy}` });
		summary.createDiv({ text: `Didn't recall ${this.results.forgot}` });
		if (this.weakIds.size) {
			const retry = host.createEl("button", {
				text: `Retest ${this.weakIds.size} weak quiz${
					this.weakIds.size === 1 ? "" : "zes"
				}`,
			});
			retry.addEventListener("click", () => this.retestWeak());
		}
		const done = host.createEl("button", { cls: "mod-cta", text: "Done" });
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
