// Event-quiz card faces in the recitation-player look, shared between the
// in-view session player and the popup (practice / reminder modals), plus
// the single-card popup player itself.

import { setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import { QuizEntry, QuizResult, isQuizReady } from "./quiz";
import {
	clozeRevealsInline,
	nextReviewLabel,
	quizAnswer,
	quizQuestion,
	quizSchedule,
} from "./quiz-display";
import { DbColors, renderQuizText } from "./quiz-render";
import { PlayerPage } from "./player-shell";
import { describeYear, parseYearTag } from "./year-tag";

export function renderQuizFaceFront(
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	event: EventEntry | undefined,
	colors: DbColors,
	hintShown: boolean,
	card: HTMLElement,
	// Extra face content between the question and the hint (the session
	// player slots the map surface here).
	extra?: (card: HTMLElement) => void
): void {
	const question = card.createDiv({ cls: "hl-player-question" });
	renderQuizText(
		plugin,
		quizQuestion(quiz, event, false),
		question,
		colors
	);
	extra?.(card);
	renderHint(plugin, quiz, colors, hintShown, card);
}

export function renderQuizFaceBack(
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	event: EventEntry | undefined,
	colors: DbColors,
	hintShown: boolean,
	card: HTMLElement,
	extra?: (card: HTMLElement) => void
): void {
	const question = card.createDiv({
		cls: "hl-player-question hl-player-question-dim",
	});
	renderQuizText(plugin, quizQuestion(quiz, event, true), question, colors);
	extra?.(card);
	if (!clozeRevealsInline(quiz)) {
		const answer = card.createDiv({ cls: "hl-player-answer" });
		renderQuizText(plugin, quizAnswer(quiz, event), answer, colors);
	}
	renderHint(plugin, quiz, colors, hintShown, card);
}

function renderHint(
	plugin: HistoryLoggingPlugin,
	quiz: QuizEntry,
	colors: DbColors,
	hintShown: boolean,
	card: HTMLElement
): void {
	if (!hintShown || !quiz.hint) return;
	const hint = card.createDiv({ cls: "hl-player-hint" });
	renderQuizText(plugin, quiz.hint, hint, colors);
}

export function renderQuizRateButtons(
	bar: HTMLElement,
	onRate: (result: QuizResult) => void
): void {
	for (const [result, label, key, note] of [
		["forgot", "不记得", "1", "退一级 · 10 分钟后重试"],
		["remembered", "记得", "2", "进一级"],
	] as [QuizResult, string, string, string][]) {
		const button = bar.createEl("button", { cls: "hl-player-rate" });
		if (result === "remembered") button.addClass("mod-cta");
		button.createDiv({ text: label });
		button.createDiv({
			cls: "hl-player-rate-note",
			text: `${key} · ${note}`,
		});
		button.addEventListener("click", () => onRate(result));
	}
}

export interface QuizPopupCallbacks {
	onRate: (result: QuizResult) => void;
	onClose: () => void;
	onEdit?: () => void;
	onTimeline?: () => void;
	// Keep the modal's reveal / hint memory in sync so a stash-restore
	// re-creates the player in the same state.
	onReveal?: () => void;
	onHint?: () => void;
	counter?: () => string;
}

// One event quiz in the recitation-player chrome, hosted by a modal: the
// top bar carries the source-year context instead of a back button, the
// progress edge shows mastery, rating is delegated back to the modal (which
// decides to close or advance its queue). Never reaches the summary state.
export class QuizPopupPlayer extends PlayerPage {
	constructor(
		plugin: HistoryLoggingPlugin,
		private quiz: QuizEntry,
		private event: EventEntry | undefined,
		private colors: DbColors,
		private cb: QuizPopupCallbacks,
		initRevealed: boolean,
		private hintShown: boolean
	) {
		super(plugin, "", () => cb.onClose());
		this.revealed = initRevealed;
	}

	protected done(): number {
		return 0;
	}

	protected total(): number {
		return 1;
	}

	protected finished(): boolean {
		return false;
	}

	// The top edge shows mastery instead of session progress — the popup
	// has no queue of its own.
	protected progressSegments(): { cls: string; frac: number }[] {
		const steps = Math.max(1, this.plugin.settings.quizMasterySteps);
		const p =
			this.quiz.status === "mastered" ? steps : this.quiz.progress;
		return [{ cls: "", frac: Math.min(1, p / steps) }];
	}

	protected renderTop(top: HTMLElement): void {
		const decoded = this.event?.tag
			? parseYearTag(this.event.tag)
			: null;
		top.createSpan({
			cls: "hl-popup-context",
			text: decoded
				? describeYear(decoded)
				: this.event?.tag ?? "来源事件已不存在",
		});
		const steps = this.plugin.settings.quizMasterySteps;
		const dots = top.createSpan({ cls: "hl-player-dots" });
		dots.setAttr("aria-label", `掌握 ${this.quiz.progress}/${steps}`);
		for (let i = 0; i < steps; i++)
			dots.createSpan({
				cls:
					i < this.quiz.progress
						? "hl-player-dot is-on"
						: "hl-player-dot",
			});
		const counter = this.cb.counter?.() ?? "";
		top.createSpan({
			cls: "hl-player-counter",
			text:
				counter ||
				(this.quiz.status === "mastered" ? "学过" : "在学"),
		});
	}

	protected renderFront(card: HTMLElement): void {
		renderQuizFaceFront(
			this.plugin,
			this.quiz,
			this.event,
			this.colors,
			this.hintShown,
			card
		);
	}

	protected renderBack(card: HTMLElement): void {
		renderQuizFaceBack(
			this.plugin,
			this.quiz,
			this.event,
			this.colors,
			this.hintShown,
			card
		);
	}

	protected renderActions(bar: HTMLElement): void {
		const schedule = quizSchedule(this.plugin.settings);
		const ready = isQuizReady(this.quiz, new Date(), schedule);
		if (!ready || this.quiz.status !== "active") {
			if (this.quiz.status === "active")
				bar.createSpan({
					cls: "hl-quiz-wait-note",
					text: nextReviewLabel(this.quiz, new Date(), schedule),
				});
			const done = bar.createEl("button", {
				cls: "mod-cta",
				text: "关闭",
			});
			done.addEventListener("click", () => this.cb.onClose());
			return;
		}
		renderQuizRateButtons(bar, (result) => this.cb.onRate(result));
	}

	protected footerExtras(left: HTMLElement, right: HTMLElement): void {
		if (this.quiz.hint && !this.hintShown) {
			const hintBtn = left.createEl("button", {
				cls: "hl-player-hint-btn",
				text: "💡 提示",
			});
			hintBtn.addEventListener("click", () => {
				this.hintShown = true;
				this.cb.onHint?.();
				this.render();
			});
		}
		if (this.cb.onEdit) {
			const edit = right.createEl("button", {
				cls: "hl-icon-btn hl-player-reveal",
			});
			setIcon(edit, "pencil");
			edit.setAttr("aria-label", "编辑这道 Quiz (E)");
			edit.addEventListener("click", () => this.cb.onEdit?.());
		}
		if (this.cb.onTimeline) {
			const reveal = right.createEl("button", {
				cls: "hl-icon-btn hl-player-reveal",
			});
			setIcon(reveal, "gantt-chart");
			reveal.setAttr("aria-label", "在时间线上显示");
			reveal.addEventListener("click", () => this.cb.onTimeline?.());
		}
	}

	protected rateFromKey(n: number): boolean {
		const schedule = quizSchedule(this.plugin.settings);
		if (
			!isQuizReady(this.quiz, new Date(), schedule) ||
			this.quiz.status !== "active"
		) {
			if (n === 1 || n === 2) this.cb.onClose();
			return true;
		}
		if (n === 1) this.cb.onRate("forgot");
		else if (n === 2) this.cb.onRate("remembered");
		else return false;
		return true;
	}

	handleKey(ev: KeyboardEvent): boolean {
		if (
			(ev.key === "e" || ev.key === "E") &&
			this.cb.onEdit &&
			!ev.ctrlKey &&
			!ev.metaKey &&
			!ev.altKey
		) {
			this.cb.onEdit();
			return true;
		}
		const handled = super.handleKey(ev);
		if (handled && this.revealed) this.cb.onReveal?.();
		return handled;
	}

	protected render(): void {
		super.render();
		if (this.revealed) this.cb.onReveal?.();
	}

	protected renderSummary(_host: HTMLElement): void {}
}
