import { setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { TimelineEntry } from "./scan";
import {
	QuizEntry,
	QuizResult,
	QuizSchedule,
	isQuizReady,
	isQuizWaiting,
	reviewQuiz,
	reviveQuiz,
} from "./quiz";
import {
	clozeRevealsInline,
	nextReviewLabel,
	quizAnswer,
	quizQuestion,
	quizSchedule,
} from "./quiz-display";
import { EventEntry } from "./types";
import { describeYear } from "./year-tag";
import { EV_SYMBOL } from "./constants";
import { openEvMenu } from "./ev-menu";
import { tracksIn } from "./tracks";
import { DbColors, renderQuizText } from "./quiz-render";

export function renderTimelineQuizCard(
	parent: HTMLElement,
	entry: TimelineEntry,
	quizzes: QuizEntry[],
	opts: {
		plugin: HistoryLoggingPlugin;
		dbColors: DbColors;
		position: number;
		setPosition(position: number): void;
		update(quiz: QuizEntry): Promise<void>;
	}
): HTMLElement {
	const card = parent.createDiv({ cls: "hl-card hl-quiz-card" });
	const schedule = quizSchedule(opts.plugin.settings);
	const ordered = [...quizzes].sort((a, b) => compareQuizzes(a, b, schedule));
	let position = Math.min(opts.position, Math.max(0, ordered.length - 1));
	let revealed = false;
	let hintShown = false;
	const event: EventEntry = {
		id: entry.evId ?? "",
		tag: entry.tag,
		summary: entry.summary ?? "",
	};

	const paint = (): void => {
		card.empty();
		const quiz = ordered[position];
		if (!quiz) return;
		const ready = isQuizReady(quiz, new Date(), schedule);
		const waiting = isQuizWaiting(quiz, new Date(), schedule);
		card.toggleClass("hl-quiz-waiting-card", waiting);
		card.toggleClass(
			"hl-quiz-cooling-card",
			quiz.status === "active" && !ready && !waiting
		);

		const head = card.createDiv({ cls: "hl-card-head hl-quiz-card-head" });
		// While this event still has an unmastered year quiz, the head year
		// would spoil it, so every sibling card keeps it masked.
		const yearLocked = ordered.some(
			(q) => q.kind === "year" && q.status !== "mastered"
		);
		const hideYear = yearLocked || (quiz.kind === "year" && !revealed);
		const peekYear =
			!hideYear && opts.plugin.settings.quizHoverHideYears;
		const yearHost = peekYear
			? head.createSpan({ cls: "hl-year-peek" })
			: head;
		if (peekYear) yearHost.setAttr("aria-label", "悬停显示年份");
		yearHost.createSpan({
			cls: "hl-year",
			text: hideYear ? "年份？" : describeYear(entry.decoded),
		});
		if (!hideYear) yearHost.createSpan({ cls: "hl-tag", text: entry.tag });
		if (entry.evId) {
			const evId = entry.evId;
			const symbol = head.createSpan({ cls: "hl-ev-symbol", text: EV_SYMBOL });
			symbol.setAttr("aria-label", "事件操作");
			symbol.addEventListener("click", (e) => {
				e.stopPropagation();
				openEvMenu(opts.plugin, e, evId, entry.tag, tracksIn(entry.block));
			});
		}
		const navigation = head.createDiv({ cls: "hl-quiz-navigation" });
		navigation.createSpan({
			cls: "hl-quiz-counter",
			text: `第 ${position + 1} 题，共 ${ordered.length} 题`,
		});
		const previous = navigation.createEl("button", { cls: "hl-icon-btn" });
		setIcon(previous, "chevron-left");
		previous.disabled = ordered.length < 2;
		previous.setAttr("aria-label", "上一个 Quiz");
		previous.addEventListener("click", (e) => {
			e.stopPropagation();
			position = (position - 1 + ordered.length) % ordered.length;
			opts.setPosition(position);
			revealed = false;
			hintShown = false;
			paint();
		});
		const next = navigation.createEl("button", { cls: "hl-icon-btn" });
		setIcon(next, "chevron-right");
		next.disabled = ordered.length < 2;
		next.setAttr("aria-label", "下一个 Quiz");
		next.addEventListener("click", (e) => {
			e.stopPropagation();
			position = (position + 1) % ordered.length;
			opts.setPosition(position);
			revealed = false;
			hintShown = false;
			paint();
		});

		const body = card.createDiv({ cls: "hl-card-body hl-quiz-card-body" });
		const question = body.createDiv({ cls: "hl-quiz-question" });
		renderQuizText(
			opts.plugin,
			quizQuestion(quiz, event, revealed),
			question,
			opts.dbColors,
			entry.filePath
		);

		const status = body.createDiv({ cls: "hl-quiz-card-status" });
		const reviewState =
			quiz.status === "mastered"
				? "学过"
				: nextReviewLabel(quiz, new Date(), schedule);
		status.createSpan({
			text: `掌握 ${quiz.progress}/${opts.plugin.settings.quizMasterySteps}${
				reviewState ? ` · ${reviewState}` : ""
			}`,
		});

		if (hintShown && quiz.hint) {
			const hint = body.createDiv({ cls: "hl-quiz-hint" });
			renderQuizText(
				opts.plugin,
				quiz.hint,
				hint,
				opts.dbColors,
				entry.filePath
			);
		}

		if (!revealed) {
			const controls = body.createDiv({ cls: "hl-quiz-card-controls" });
			if (quiz.hint)
				addHintToggle(controls, hintShown, () => {
					hintShown = !hintShown;
					paint();
				});
			const show = controls.createEl("button", {
				cls: "mod-cta",
				text: "显示答案",
			});
			show.disabled = waiting;
			if (waiting) show.setAttr("aria-label", "等待中，稍后再练");
			show.addEventListener("click", (e) => {
				e.stopPropagation();
				revealed = true;
				paint();
			});
			return;
		}

		if (!clozeRevealsInline(quiz)) {
			const answer = body.createDiv({ cls: "hl-quiz-answer" });
			renderQuizText(
				opts.plugin,
				quizAnswer(quiz, event),
				answer,
				opts.dbColors,
				entry.filePath
			);
		}
		const controls = body.createDiv({ cls: "hl-quiz-card-controls" });
		if (quiz.hint)
			addHintToggle(controls, hintShown, () => {
				hintShown = !hintShown;
				paint();
			});
		if (quiz.status === "active" && ready) {
			for (const [result, label] of [
				["forgot", "不记得"],
				["remembered", "记得"],
			] as [QuizResult, string][]) {
				const button = controls.createEl("button", { text: label });
				if (result === "remembered") button.addClass("mod-cta");
				button.setAttr(
					"aria-label",
					result === "forgot"
						? "不记得：掌握退一级并进入等待"
						: "记得：掌握进一级"
				);
				button.addEventListener("click", (e) => {
					e.stopPropagation();
					const updated = reviewQuiz(
						quiz,
						result,
						new Date(),
						schedule
					);
					opts.plugin.remindQuizWhenReady(updated);
					void opts.update(updated);
				});
			}
		} else if (quiz.status === "active") {
			controls.createSpan({
				cls: "hl-quiz-wait-note",
				text: nextReviewLabel(quiz, new Date(), schedule),
			});
		} else if (quiz.status === "mastered") {
			const revive = controls.createEl("button", {
				cls: "mod-cta",
				text: "重新学习",
			});
			revive.addEventListener("click", (e) => {
				e.stopPropagation();
				void opts.update(reviveQuiz(quiz));
			});
		}
	};

	paint();
	return card;
}

function addHintToggle(
	controls: HTMLElement,
	shown: boolean,
	toggle: () => void
): void {
	const hint = controls.createEl("button", { text: "提示" });
	hint.setAttr("aria-pressed", String(shown));
	hint.addEventListener("click", (event) => {
		event.stopPropagation();
		toggle();
	});
}

function compareQuizzes(
	a: QuizEntry,
	b: QuizEntry,
	schedule: QuizSchedule
): number {
	const now = new Date();
	const ready =
		Number(isQuizReady(b, now, schedule)) -
		Number(isQuizReady(a, now, schedule));
	if (ready) return ready;
	const aForgot = a.attempts[a.attempts.length - 1]?.result === "forgot";
	const bForgot = b.attempts[b.attempts.length - 1]?.result === "forgot";
	if (aForgot !== bForgot) return Number(bForgot) - Number(aForgot);
	return a.progress - b.progress || a.updated.localeCompare(b.updated);
}
