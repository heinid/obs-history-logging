import { MarkdownRenderer, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { TimelineEntry } from "./scan";
import {
	QuizEntry,
	QuizResult,
	isQuizReady,
	resumeQuiz,
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

export function renderTimelineQuizCard(
	parent: HTMLElement,
	entry: TimelineEntry,
	quizzes: QuizEntry[],
	opts: {
		plugin: HistoryLoggingPlugin;
		position: number;
		setPosition(position: number): void;
		update(quiz: QuizEntry): Promise<void>;
	}
): HTMLElement {
	const card = parent.createDiv({ cls: "hl-card hl-quiz-card" });
	const ordered = [...quizzes].sort(compareQuizzes);
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
		const ready = isQuizReady(quiz);
		card.toggleClass(
			"hl-quiz-cooling-card",
			quiz.status === "active" && !ready
		);

		const head = card.createDiv({ cls: "hl-card-head hl-quiz-card-head" });
		const hideYear = quiz.kind === "year" && !revealed;
		head.createSpan({
			cls: "hl-year",
			text: hideYear ? "Year ?" : describeYear(entry.decoded),
		});
		if (!hideYear) head.createSpan({ cls: "hl-tag", text: entry.tag });
		if (entry.evId) {
			const evId = entry.evId;
			const symbol = head.createSpan({ cls: "hl-ev-symbol", text: EV_SYMBOL });
			symbol.setAttr("aria-label", "Event actions");
			symbol.addEventListener("click", (e) => {
				e.stopPropagation();
				openEvMenu(opts.plugin, e, evId, entry.tag, tracksIn(entry.block));
			});
		}
		const navigation = head.createDiv({ cls: "hl-quiz-navigation" });
		navigation.createSpan({
			cls: "hl-quiz-counter",
			text: `Question ${position + 1} of ${ordered.length}`,
		});
		const previous = navigation.createEl("button", { cls: "hl-icon-btn" });
		setIcon(previous, "chevron-left");
		previous.disabled = ordered.length < 2;
		previous.setAttr("aria-label", "Previous quiz");
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
		next.setAttr("aria-label", "Next quiz");
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
		void MarkdownRenderer.render(
			opts.plugin.app,
			quizQuestion(quiz, event, revealed),
			question,
			entry.filePath,
			opts.plugin
		);

		const status = body.createDiv({ cls: "hl-quiz-card-status" });
		const schedule =
			quiz.status === "mastered"
				? "已掌握"
				: quiz.status === "paused"
				? "已暂停学习"
				: nextReviewLabel(quiz);
		status.createSpan({
			text: `掌握 ${quiz.progress}/${opts.plugin.settings.quizMasterySteps}${
				schedule ? ` · ${schedule}` : ""
			}`,
		});

		if (hintShown && quiz.hint) {
			const hint = body.createDiv({ cls: "hl-quiz-hint" });
			void MarkdownRenderer.render(
				opts.plugin.app,
				quiz.hint,
				hint,
				entry.filePath,
				opts.plugin
			);
		}

		if (!revealed) {
			const controls = body.createDiv({ cls: "hl-quiz-card-controls" });
			if (quiz.hint && !hintShown) {
				const hint = controls.createEl("button", { text: "提示" });
				hint.addEventListener("click", (e) => {
					e.stopPropagation();
					hintShown = true;
					paint();
				});
			}
			const show = controls.createEl("button", {
				cls: "mod-cta",
				text:
					quiz.status === "active" && !ready
						? "立即练习"
						: "显示答案",
			});
			show.addEventListener("click", (e) => {
				e.stopPropagation();
				revealed = true;
				paint();
			});
			if (quiz.status === "active" && !ready)
				controls.createSpan({
					cls: "hl-quiz-early-note",
					text: "提前练习答对不会推进掌握。",
				});
			return;
		}

		if (!clozeRevealsInline(quiz)) {
			const answer = body.createDiv({ cls: "hl-quiz-answer" });
			void MarkdownRenderer.render(
				opts.plugin.app,
				quizAnswer(quiz, event),
				answer,
				entry.filePath,
				opts.plugin
			);
		}
		const controls = body.createDiv({ cls: "hl-quiz-card-controls" });
		if (quiz.status === "active") {
			for (const [result, label] of [
				["forgot", "不记得"],
				["remembered", "记得"],
			] as [QuizResult, string][]) {
				const button = controls.createEl("button", { text: label });
				if (result === "remembered") button.addClass("mod-cta");
				button.setAttr(
					"aria-label",
					result === "forgot"
						? "不记得：掌握退一级并在短间隔后重试"
						: "记得：到达练习时间时掌握进一级"
				);
				button.addEventListener("click", (e) => {
					e.stopPropagation();
					const updated = reviewQuiz(
						quiz,
						result,
						new Date(),
						quizSchedule(opts.plugin.settings)
					);
					void opts.update(updated);
				});
			}
		} else if (quiz.status === "mastered") {
			const revive = controls.createEl("button", {
				cls: "mod-cta",
				text: "重新学习",
			});
			revive.addEventListener("click", (e) => {
				e.stopPropagation();
				void opts.update(reviveQuiz(quiz));
			});
		} else if (quiz.status === "paused") {
			const resume = controls.createEl("button", {
				cls: "mod-cta",
				text: "继续学习",
			});
			resume.addEventListener("click", (e) => {
				e.stopPropagation();
				void opts.update(resumeQuiz(quiz));
			});
		}
		const source = controls.createEl("button", { text: "打开来源" });
		source.addEventListener("click", (e) => {
			e.stopPropagation();
			opts.plugin.openSummary(entry.evId ?? "", entry.tag);
		});
	};

	paint();
	return card;
}

function compareQuizzes(a: QuizEntry, b: QuizEntry): number {
	const ready = Number(isQuizReady(b)) - Number(isQuizReady(a));
	if (ready) return ready;
	const aForgot = a.attempts[a.attempts.length - 1]?.result === "forgot";
	const bForgot = b.attempts[b.attempts.length - 1]?.result === "forgot";
	if (aForgot !== bForgot) return Number(bForgot) - Number(aForgot);
	return a.progress - b.progress || a.updated.localeCompare(b.updated);
}
