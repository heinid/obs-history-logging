export type QuizKind = "year" | "cloze" | "qa";
export type QuizStatus = "active" | "mastered";
export type QuizResult = "remembered" | "fuzzy" | "forgot";

export interface QuizAttempt {
	at: string;
	result: QuizResult;
	early: boolean;
	progressBefore: number;
	progressAfter: number;
}

export interface MasteryCycle {
	startedAt: string;
	completedAt?: string;
}

export interface QuizEntry {
	id: string;
	sourceEvId: string;
	kind: QuizKind;
	status: QuizStatus;
	progress: number;
	nextReview?: string;
	pendingRecheck?: boolean;
	created: string;
	updated: string;
	question: string;
	answer: string;
	hint: string;
	attempts: QuizAttempt[];
	cycles: MasteryCycle[];
}

export interface QuizSchedule {
	masterySteps: number;
	intervalMinutes: number[];
	retryMinutes: number;
	recheckMinutes: number;
	remindRecheck: boolean;
}

export const DEFAULT_QUIZ_SCHEDULE: QuizSchedule = {
	masterySteps: 3,
	intervalMinutes: [24 * 60, 3 * 24 * 60],
	retryMinutes: 10,
	recheckMinutes: 10,
	remindRecheck: false,
};

export function isQuizReady(
	quiz: QuizEntry,
	now = new Date(),
	schedule = DEFAULT_QUIZ_SCHEDULE
): boolean {
	if (quiz.status !== "active") return false;
	if (!quiz.nextReview) return true;
	const due = Date.parse(quiz.nextReview);
	if (Number.isNaN(due) || due <= now.getTime()) return true;
	const maximumDelay =
		Math.max(
			0,
			schedule.retryMinutes,
			schedule.recheckMinutes,
			...schedule.intervalMinutes
		) * 60_000;
	return due - now.getTime() > maximumDelay;
}

// An active quiz sitting out a short wait (forgot retry or first-learn
// recheck) stays visibly parked in the Active view; day-scale intervals
// simply drop it from the queue instead.
export function isQuizWaiting(
	quiz: QuizEntry,
	now = new Date(),
	schedule = DEFAULT_QUIZ_SCHEDULE
): boolean {
	if (quiz.status !== "active" || !quiz.nextReview) return false;
	if (isQuizReady(quiz, now, schedule)) return false;
	const due = Date.parse(quiz.nextReview);
	if (Number.isNaN(due)) return false;
	const horizon =
		Math.max(0, schedule.retryMinutes, schedule.recheckMinutes) * 60_000;
	return due - now.getTime() <= horizon;
}

export function reviewQuiz(
	quiz: QuizEntry,
	result: QuizResult,
	now: Date,
	schedule: QuizSchedule
): QuizEntry {
	const at = now.toISOString();
	const before = quiz.progress;
	const early = !isQuizReady(quiz, now, schedule);
	const next: QuizEntry = {
		...quiz,
		attempts: [...quiz.attempts],
		cycles: quiz.cycles.map((cycle) => ({ ...cycle })),
		updated: at,
	};

	if (!next.cycles.length)
		next.cycles.push({ startedAt: quiz.created || at });

	if (result === "remembered" && !early && shouldRecheck(quiz, schedule)) {
		next.pendingRecheck = true;
		next.nextReview = addMinutes(
			now,
			Math.max(0, schedule.recheckMinutes)
		);
	} else if (result === "remembered" && !early) {
		next.pendingRecheck = false;
		next.progress = Math.min(
			Math.max(1, schedule.masterySteps),
			before + 1
		);
		if (next.progress >= Math.max(1, schedule.masterySteps)) {
			next.status = "mastered";
			next.nextReview = undefined;
			const cycle = next.cycles[next.cycles.length - 1];
			if (cycle && !cycle.completedAt) cycle.completedAt = at;
		} else {
			next.nextReview = addMinutes(
				now,
				intervalForProgress(next.progress, schedule)
			);
		}
	} else if (result === "forgot") {
		next.pendingRecheck = false;
		next.progress = Math.max(0, before - 1);
		next.status = "active";
		next.nextReview = addMinutes(now, Math.max(0, schedule.retryMinutes));
	} else if (!early) {
		next.nextReview = addMinutes(now, Math.max(0, schedule.retryMinutes));
	}

	next.attempts.push({
		at,
		result,
		early,
		progressBefore: before,
		progressAfter: next.progress,
	});
	return next;
}

function shouldRecheck(quiz: QuizEntry, schedule: QuizSchedule): boolean {
	return (
		schedule.remindRecheck &&
		quiz.progress === 0 &&
		!quiz.pendingRecheck
	);
}

export function reviveQuiz(quiz: QuizEntry, now = new Date()): QuizEntry {
	const at = now.toISOString();
	return {
		...quiz,
		status: "active",
		progress: 0,
		nextReview: undefined,
		pendingRecheck: false,
		updated: at,
		attempts: [...quiz.attempts],
		cycles: [...quiz.cycles.map((cycle) => ({ ...cycle })), { startedAt: at }],
	};
}

function intervalForProgress(
	progress: number,
	schedule: QuizSchedule
): number {
	if (!schedule.intervalMinutes.length) return 0;
	const index = Math.min(progress - 1, schedule.intervalMinutes.length - 1);
	return Math.max(0, schedule.intervalMinutes[index] ?? 0);
}

function addMinutes(now: Date, minutes: number): string {
	return new Date(now.getTime() + minutes * 60_000).toISOString();
}
