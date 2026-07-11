import { EventEntry } from "./types";
import {
	DEFAULT_QUIZ_SCHEDULE,
	QuizEntry,
	QuizSchedule,
	isQuizReady,
} from "./quiz";
import { HistoryLoggingSettings } from "./settings";
import { describeYear, parseYearTag } from "./year-tag";

export function quizQuestion(
	quiz: QuizEntry,
	event: EventEntry | undefined,
	revealCloze = false
): string {
	const question =
		quiz.question.trim() ||
		(quiz.kind === "year" ? event?.summary.trim() : "") ||
		(quiz.kind === "year" ? "这件事发生在哪一年？" : "未命名 Quiz");
	if (quiz.kind === "cloze" && revealCloze && question.includes("____"))
		return question.replace("____", `==${quiz.answer.trim()}==`);
	return quiz.kind === "year"
		? maskSourceYear(question, event)
		: question;
}

export function clozeRevealsInline(quiz: QuizEntry): boolean {
	return quiz.kind === "cloze" && quiz.question.includes("____");
}

export function quizAnswer(
	quiz: QuizEntry,
	event: EventEntry | undefined
): string {
	if (quiz.kind !== "year") return quiz.answer;
	const decoded = event?.tag ? parseYearTag(event.tag) : null;
	return decoded ? describeYear(decoded) : event?.tag ?? "来源年份不可用";
}

export function quizSchedule(settings: HistoryLoggingSettings): QuizSchedule {
	return {
		masterySteps: Math.max(1, settings.quizMasterySteps),
		intervalMinutes: settings.quizIntervalsMinutes.length
			? settings.quizIntervalsMinutes
			: [10, 24 * 60],
		retryMinutes: Math.max(0, settings.quizRetryMinutes),
	};
}

export function maskSourceYear(
	text: string,
	event: EventEntry | undefined
): string {
	if (!event?.tag) return text;
	const decoded = parseYearTag(event.tag);
	let masked = text.split(event.tag).join("____");
	if (!decoded || decoded.precision !== "year") return masked;
	const magnitude = String(decoded.magnitude);
	const exactYear = new RegExp(
		`(^|[^0-9])(?:前\\s*)?${magnitude}(?:\\s*BC)?(?![0-9])`,
		"gi"
	);
	masked = masked.replace(exactYear, "$1____");
	return masked;
}

export function nextReviewLabel(
	quiz: QuizEntry,
	now = new Date(),
	schedule = DEFAULT_QUIZ_SCHEDULE
): string {
	if (!quiz.nextReview || isQuizReady(quiz, now, schedule)) return "";
	const time = Date.parse(quiz.nextReview);
	const minutes = Math.ceil((time - now.getTime()) / 60_000);
	if (minutes < 60) return `${minutes} 分钟后可推进`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `${hours} 小时后可推进`;
	const days = Math.ceil(hours / 24);
	return `${days} 天后可推进`;
}
