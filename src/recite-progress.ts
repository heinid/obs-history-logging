// Persistent recitation progress, one record per «entity × from → to
// language». Progress belongs to the direction key globally — decks/views
// only reference it, so the same word never keeps two accounts. Scheduling
// reuses the quiz engine via a thin adapter.
//
//   # History Logging — recite progress
//
//   - q3x8k2p1 zh>ja | active | 1 | 2026-07-20T09:00:00.000Z | - | remembered | 2026-07-10T… | 2026-07-19T…

import {
	QuizEntry,
	QuizResult,
	QuizSchedule,
	QuizSectionKey,
	isQuizReady,
	isQuizShortLoop,
	isQuizWaiting,
	reviewQuiz,
} from "./quiz";

export interface ReciteProgress {
	entity: string;
	from: string;
	to: string;
	status: "active" | "mastered";
	progress: number;
	nextReview?: string;
	pendingRecheck?: boolean;
	lastResult?: "remembered" | "forgot";
	created: string;
	updated: string;
}

export const RECITE_PROGRESS_HEADER = "# History Logging — recite progress";

export function progressKey(
	entity: string,
	from: string,
	to: string
): string {
	return `${entity} ${from}>${to}`;
}

export function keyOf(p: ReciteProgress): string {
	return progressKey(p.entity, p.from, p.to);
}

export function newProgress(
	entity: string,
	from: string,
	to: string,
	now = new Date()
): ReciteProgress {
	const at = now.toISOString();
	return {
		entity,
		from,
		to,
		status: "active",
		progress: 0,
		created: at,
		updated: at,
	};
}

export function parseReciteProgressFile(
	content: string
): Map<string, ReciteProgress> {
	const map = new Map<string, ReciteProgress>();
	for (const raw of content.replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trim();
		if (!line.startsWith("-")) continue;
		const parts = line
			.replace(/^-\s*/, "")
			.split("|")
			.map((s) => s.trim());
		if (parts.length < 8) continue;
		const key = /^(\S+)\s+([^>\s]+)>(\S+)$/.exec(parts[0]);
		if (!key) continue;
		const progress = Number(parts[2]);
		if (!Number.isInteger(progress) || progress < 0) continue;
		const rec: ReciteProgress = {
			entity: key[1],
			from: key[2],
			to: key[3],
			status: parts[1] === "mastered" ? "mastered" : "active",
			progress,
			nextReview: parts[3] !== "-" ? parts[3] : undefined,
			pendingRecheck: parts[4] === "recheck" || undefined,
			lastResult:
				parts[5] === "remembered" || parts[5] === "forgot"
					? parts[5]
					: undefined,
			created: parts[6],
			updated: parts[7],
		};
		map.set(keyOf(rec), rec);
	}
	return map;
}

export function serializeReciteProgressFile(
	records: Map<string, ReciteProgress>
): string {
	const parts = [RECITE_PROGRESS_HEADER, ""];
	for (const key of [...records.keys()].sort()) {
		const p = records.get(key);
		if (!p) continue;
		parts.push(
			`- ${keyOf(p)} | ${p.status} | ${p.progress} | ${
				p.nextReview ?? "-"
			} | ${p.pendingRecheck ? "recheck" : "-"} | ${
				p.lastResult ?? "-"
			} | ${p.created} | ${p.updated}`
		);
	}
	parts.push("");
	return parts.join("\n").replace(/\n+$/, "\n");
}

// Quiz-shaped adapter so quiz readiness / scheduling / stats helpers apply
// unchanged. The single reconstructed attempt carries what the short-loop
// checks need: the last result.
export function toQuizShape(p: ReciteProgress): QuizEntry {
	return {
		id: keyOf(p),
		sourceEvId: p.entity,
		kind: "qa",
		status: p.status,
		progress: p.progress,
		nextReview: p.nextReview,
		pendingRecheck: p.pendingRecheck,
		created: p.created,
		updated: p.updated,
		question: "",
		answer: "",
		hint: "",
		attempts: p.lastResult
			? [
					{
						at: p.updated,
						result: p.lastResult,
						early: false,
						// A remembered pass that raised the score is the
						// only step-clearing shape the short-loop and
						// section checks look for.
						progressBefore:
							p.lastResult === "remembered" &&
							p.progress > 0 &&
							!p.pendingRecheck
								? p.progress - 1
								: p.progress,
						progressAfter: p.progress,
					},
			  ]
			: [],
		cycles: [{ startedAt: p.created }],
	};
}

export function reviewProgress(
	p: ReciteProgress,
	result: QuizResult,
	now: Date,
	schedule: QuizSchedule
): ReciteProgress {
	const next = reviewQuiz(toQuizShape(p), result, now, schedule);
	return {
		...p,
		status: next.status,
		progress: next.progress,
		nextReview: next.nextReview,
		pendingRecheck: next.pendingRecheck || undefined,
		lastResult:
			result === "remembered" || result === "forgot"
				? result
				: p.lastResult,
		updated: next.updated,
	};
}

// Exclusive study section for a direction, mirroring the quiz model but
// judging «passed» by the stored score (only the last attempt survives).
export function progressSection(
	p: ReciteProgress,
	now: Date,
	schedule: QuizSchedule
): QuizSectionKey {
	if (p.status === "mastered") return "mastered";
	const shape = toQuizShape(p);
	if (isQuizShortLoop(shape, now, schedule)) return "waiting";
	if (p.progress === 0) return "fresh";
	return isQuizReady(shape, now, schedule) ? "due" : "active";
}

// A direction is due when it was never studied or its record is ready.
export function isProgressDue(
	p: ReciteProgress | undefined,
	now: Date,
	schedule: QuizSchedule
): boolean {
	if (!p) return true;
	return p.status === "active" && isQuizReady(toQuizShape(p), now, schedule);
}

export function isProgressWaiting(
	p: ReciteProgress | undefined,
	now: Date,
	schedule: QuizSchedule
): boolean {
	if (!p) return false;
	return isQuizWaiting(toQuizShape(p), now, schedule);
}
