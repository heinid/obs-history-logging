// Aggregated quiz metadata for a profile deck card. Pure so it is testable
// outside Obsidian.

import {
	QuizEntry,
	QuizResult,
	QuizSchedule,
	isQuizReady,
} from "./quiz";

export interface DeckStats {
	active: number;
	mastered: number;
	due: number; // active quizzes ready to review now
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
		lastResults: { remembered: 0, fuzzy: 0, forgot: 0 },
	};
	let lastAt = "";
	for (const q of quizzes) {
		if (q.status === "mastered") stats.mastered++;
		else if (q.status === "active") {
			stats.active++;
			if (isQuizReady(q, now, schedule)) stats.due++;
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
