import { EventEntry } from "./types";
import {
	DEFAULT_QUIZ_SCHEDULE,
	QuizEntry,
	QuizSchedule,
	isQuizReady,
} from "./quiz";
import { HistoryLoggingSettings } from "./settings";
import { describeYear, parseYearTag } from "./year-tag";
import { mapDbText } from "./db-marker";

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
			: [24 * 60, 3 * 24 * 60],
		retryMinutes: Math.max(0, settings.quizRetryMinutes),
		recheckMinutes: Math.max(0, settings.quizRecheckMinutes),
		remindRecheck: settings.quizRemindRecheck,
		parkMinutes: Math.max(0, settings.quizParkHours) * 60,
	};
}

export function maskSourceYear(
	text: string,
	event: EventEntry | undefined
): string {
	if (!event?.tag) return text;
	const decoded = parseYearTag(event.tag);
	const tag = event.tag;
	const magnitude =
		decoded && decoded.precision === "year"
			? String(decoded.magnitude)
			: null;
	const exactYear = magnitude
		? new RegExp(
				`(^|[^0-9])(?:前\\s*)?${magnitude}(?:\\s*BC)?(?![0-9])`,
				"gi"
		  )
		: null;
	const mask = (chunk: string): string => {
		let masked = chunk.split(tag).join("____");
		if (exactYear) masked = masked.replace(exactYear, "$1____");
		return masked;
	};
	// Mask around and inside `{db …}` markers without touching their ids,
	// so entity references survive the year mask intact.
	return mapDbText(text, mask);
}

export function nextReviewLabel(
	quiz: QuizEntry,
	now = new Date(),
	schedule = DEFAULT_QUIZ_SCHEDULE
): string {
	if (!quiz.nextReview || isQuizReady(quiz, now, schedule)) return "";
	const time = Date.parse(quiz.nextReview);
	const minutes = Math.ceil((time - now.getTime()) / 60_000);
	if (minutes < 60) return `${minutes} 分钟后`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `${hours} 小时后`;
	const days = Math.ceil(hours / 24);
	return days <= 1 ? "明天" : `${days} 天后`;
}

// Countdown line for a card sitting in the short retry/recheck loop; empty
// once the wait is over.
export function shortWaitLabel(
	quiz: QuizEntry,
	now = new Date(),
	schedule = DEFAULT_QUIZ_SCHEDULE
): string {
	const label = nextReviewLabel(quiz, now, schedule);
	if (!label) return "";
	return quiz.pendingRecheck
		? `⏰ 重温确认 · ${label}`
		: `⏰ 重试 · ${label}`;
}

// Milliseconds until the wall clock next changes what the recitation pages
// show: the nearest wait deadline, a countdown label ticking down (minute
// steps under an hour, hour steps under a day), or the day rollover for
// "上次 X 天前" lines. At most one timer per day (the midnight rollover).
export function nextClockDelay(
	quizzes: Iterable<QuizEntry>,
	schedule = DEFAULT_QUIZ_SCHEDULE,
	now = new Date()
): number | null {
	let next = Infinity;
	for (const quiz of quizzes) {
		if (quiz.status !== "active" || !quiz.nextReview) continue;
		const due = Date.parse(quiz.nextReview);
		if (Number.isNaN(due)) continue;
		const left = due - now.getTime();
		if (left <= 0) continue;
		if (isQuizReady(quiz, now, schedule)) continue;
		next = Math.min(next, left);
		if (left < 60 * 60_000) next = Math.min(next, 60_000);
		else if (left < 24 * 60 * 60_000)
			next = Math.min(next, left % (60 * 60_000) || 60 * 60_000);
	}
	const midnight = new Date(now);
	midnight.setHours(24, 0, 0, 0);
	next = Math.min(next, midnight.getTime() - now.getTime());
	if (!Number.isFinite(next)) return null;
	return Math.max(1000, next);
}

// Feedback right after rating: make the "remembered → recheck pending"
// outcome unmistakable instead of a bare progress line.
export function rateNotice(
	quiz: QuizEntry,
	masterySteps: number,
	schedule = DEFAULT_QUIZ_SCHEDULE
): string {
	if (quiz.status === "mastered") return "这个 Quiz 已学过。";
	if (quiz.pendingRecheck)
		return `✓ 已记住 · ⏰ ${Math.max(
			0,
			schedule.recheckMinutes
		)} 分钟后重温确认，通过才算完成这一步`;
	return `掌握进度：${quiz.progress}/${masterySteps}`;
}
