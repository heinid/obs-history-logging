import { App, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { QuizEntry, addMinutes, isQuizReady } from "./quiz";
import { quizSchedule } from "./quiz-display";
import { QuizPracticeModal } from "./quiz-modal";

// Alarm-style reminder for quizzes coming off a short wait (forgot retry or
// first-learn recheck): a full practice modal opens on due, with a banner
// offering per-quiz snooze. Quizzes due while it is open join its queue, so
// at most one reminder window ever exists.
export class QuizReminderModal extends QuizPracticeModal {
	private queue: string[] = [];

	constructor(
		app: App,
		plugin: HistoryLoggingPlugin,
		quizId: string,
		onClosed?: () => void
	) {
		super(app, plugin, quizId, onClosed);
	}

	enqueue(quizId: string): void {
		if (quizId === this.quizId || this.queue.includes(quizId)) return;
		this.queue.push(quizId);
		this.render();
	}

	protected renderBanner(host: HTMLElement): void {
		const banner = host.createDiv({ cls: "hl-quiz-reminder-banner" });
		const label = banner.createSpan({ cls: "hl-quiz-reminder-label" });
		const bell = label.createSpan();
		setIcon(bell, "alarm-clock");
		const total = this.queue.length + 1;
		label.createSpan({
			text: total > 1 ? `复核提醒 · 共 ${total} 道` : "复核提醒",
		});
		const actions = banner.createDiv({ cls: "hl-quiz-reminder-actions" });
		const minutes = this.snoozeMinutes();
		const snooze = actions.createEl("button", {
			text: `顺延 ${minutes} 分钟`,
		});
		snooze.setAttr("aria-label", "这道题稍后再提醒");
		snooze.addEventListener("click", () => void this.snooze(minutes));
		const later = actions.createEl("button", { text: "稍后再说" });
		later.setAttr("aria-label", "关闭提醒，题目留在可练队列");
		later.addEventListener("click", () => this.close());
	}

	private snoozeMinutes(): number {
		const schedule = quizSchedule(this.plugin.settings);
		const base = this.quiz?.pendingRecheck
			? schedule.recheckMinutes
			: schedule.retryMinutes;
		return Math.max(1, base);
	}

	private async snooze(minutes: number): Promise<void> {
		if (!this.quiz) {
			await this.advance();
			return;
		}
		const updated: QuizEntry = {
			...this.quiz,
			nextReview: addMinutes(new Date(), minutes),
			updated: new Date().toISOString(),
		};
		await this.plugin.store.upsertQuiz(updated);
		this.plugin.remindQuizWhenReady(updated);
		await this.plugin.refreshTimelines();
		await this.advance();
	}

	protected afterRate(): void {
		void this.advance();
	}

	// Move to the next due quiz in the queue, or close when it runs dry.
	private async advance(): Promise<void> {
		const next = this.queue.shift();
		if (!next) {
			this.close();
			return;
		}
		this.quizId = next;
		this.revealed = false;
		this.hintShown = false;
		await this.loadQuiz();
		if (
			!this.quiz ||
			this.quiz.status !== "active" ||
			!isQuizReady(this.quiz, new Date(), quizSchedule(this.plugin.settings))
		) {
			await this.advance();
			return;
		}
		this.render();
	}
}
