import { EventEntry } from "./types";
import { QuizEntry, QuizSchedule } from "./quiz";
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
		(quiz.kind === "year"
			? "When did this event happen?"
			: "Untitled quiz");
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
	return decoded ? describeYear(decoded) : event?.tag ?? "Source year unavailable";
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

export function nextReviewLabel(quiz: QuizEntry, now = new Date()): string {
	if (!quiz.nextReview) return "Ready";
	const time = Date.parse(quiz.nextReview);
	if (Number.isNaN(time) || time <= now.getTime()) return "Ready";
	const minutes = Math.ceil((time - now.getTime()) / 60_000);
	if (minutes < 60) return `In ${minutes} min`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `In ${hours} hr`;
	const days = Math.ceil(hours / 24);
	return `In ${days} day${days === 1 ? "" : "s"}`;
}
