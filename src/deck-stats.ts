// Aggregated quiz metadata for a profile deck card. Pure so it is testable
// outside Obsidian.

import {
	QuizEntry,
	QuizResult,
	QuizSchedule,
	isQuizReady,
	isQuizWaiting,
} from "./quiz";

export interface DeckStats {
	active: number;
	mastered: number;
	due: number; // active quizzes ready to review now
	waiting: number; // active quizzes sitting out a short retry/recheck wait
	// Count of active quizzes per mastery progress step (index = progress).
	progressDist: number[];
	lastReviewedAt?: string; // ISO of the most recent attempt
	// Result tallies of the most recent review day.
	lastResults: Record<QuizResult, number>;
}

export function quizDeckStats(
	quizzes: QuizEntry[],
	now: Date,
	schedule: QuizSchedule
): DeckStats {
	const stats: DeckStats = {
		active: 0,
		mastered: 0,
		due: 0,
		waiting: 0,
		progressDist: new Array(Math.max(1, schedule.masterySteps)).fill(0),
		lastResults: { remembered: 0, fuzzy: 0, forgot: 0 },
	};
	let lastAt = "";
	for (const q of quizzes) {
		if (q.status === "mastered") stats.mastered++;
		else if (q.status === "active") {
			stats.active++;
			if (isQuizReady(q, now, schedule)) stats.due++;
			if (isQuizWaiting(q, now, schedule)) stats.waiting++;
			const step = Math.min(
				Math.max(0, q.progress),
				stats.progressDist.length - 1
			);
			stats.progressDist[step]++;
		}
		const attempt = q.attempts[q.attempts.length - 1];
		if (attempt && attempt.at > lastAt) lastAt = attempt.at;
	}
	if (!lastAt) return stats;
	stats.lastReviewedAt = lastAt;
	const lastDay = lastAt.slice(0, 10);
	for (const q of quizzes)
		for (const a of q.attempts)
			if (a.at.slice(0, 10) === lastDay) stats.lastResults[a.result]++;
	return stats;
}

// Vault-wide pulse for the hub's overview bar.
export interface OverviewStats {
	dueNow: number;
	waiting: number;
	nextWaitDue?: string; // earliest short-wait due time (ISO)
	reviewedToday: number; // attempts made today (UTC day)
	upcoming: number; // active, day-scale future (not ready, not waiting)
}

export function quizOverviewStats(
	quizzes: QuizEntry[],
	now: Date,
	schedule: QuizSchedule
): OverviewStats {
	const out: OverviewStats = {
		dueNow: 0,
		waiting: 0,
		reviewedToday: 0,
		upcoming: 0,
	};
	const today = now.toISOString().slice(0, 10);
	for (const q of quizzes) {
		for (const a of q.attempts)
			if (a.at.slice(0, 10) === today) out.reviewedToday++;
		if (q.status !== "active") continue;
		if (isQuizReady(q, now, schedule)) out.dueNow++;
		else if (isQuizWaiting(q, now, schedule)) {
			out.waiting++;
			if (
				q.nextReview &&
				(!out.nextWaitDue || q.nextReview < out.nextWaitDue)
			)
				out.nextWaitDue = q.nextReview;
		} else out.upcoming++;
	}
	return out;
}
