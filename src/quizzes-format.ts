import {
	MasteryCycle,
	QuizAttempt,
	DEFAULT_QUIZ_SCHEDULE,
	QuizEntry,
	QuizKind,
	QuizResult,
	QuizStatus,
} from "./quiz";

export const QUIZZES_HEADER = "# History Logging — quizzes";

const KINDS = new Set<QuizKind>(["year", "cloze", "qa"]);
const STATUSES = new Set<QuizStatus>(["active", "mastered"]);
const LEGACY_STATUSES = new Set(["paused", "retired"]);
const RESULTS = new Set<QuizResult>(["remembered", "fuzzy", "forgot"]);

export function parseQuizzesFile(content: string): Map<string, QuizEntry> {
	const normalised = content.replace(/\r\n/g, "\n");
	const heading = /^##\s+([0-9a-z]{8})\s*$/gm;
	const heads: { id: string; start: number; bodyStart: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = heading.exec(normalised)) !== null)
		heads.push({
			id: match[1],
			start: match.index,
			bodyStart: match.index + match[0].length,
		});

	const quizzes = new Map<string, QuizEntry>();
	for (let i = 0; i < heads.length; i++) {
		const head = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		quizzes.set(
			head.id,
			parseQuizBlock(head.id, normalised.slice(head.bodyStart, end))
		);
	}
	return quizzes;
}

function parseQuizBlock(id: string, block: string): QuizEntry {
	const now = new Date(0).toISOString();
	const quiz: QuizEntry = {
		id,
		sourceEvId: "",
		kind: "qa",
		status: "active",
		progress: 0,
		created: now,
		updated: now,
		question: "",
		answer: "",
		hint: "",
		attempts: [],
		cycles: [],
	};
	let storedStatus = "active";
	const firstSection = block.search(/^###\s+/m);
	const metadata = firstSection >= 0 ? block.slice(0, firstSection) : block;
	for (const raw of metadata.split("\n")) {
		const field = /^(\w+):\s*(.*)$/.exec(raw.trim());
		if (!field) continue;
		const [, key, value] = field;
		if (key === "sourceEvId") quiz.sourceEvId = value.trim();
		else if (key === "kind" && KINDS.has(value.trim() as QuizKind))
			quiz.kind = value.trim() as QuizKind;
		else if (
			key === "status" &&
			(STATUSES.has(value.trim() as QuizStatus) ||
				LEGACY_STATUSES.has(value.trim()))
		)
			storedStatus = value.trim();
		else if (key === "progress") {
			const progress = Number(value);
			if (Number.isInteger(progress) && progress >= 0)
				quiz.progress = progress;
		} else if (key === "nextReview" && value.trim())
			quiz.nextReview = value.trim();
		else if (key === "created" && value.trim()) quiz.created = value.trim();
		else if (key === "updated" && value.trim()) quiz.updated = value.trim();
	}

	const sections = splitSections(block);
	quiz.question = sections.get("question") ?? "";
	quiz.answer = sections.get("answer") ?? "";
	quiz.hint = sections.get("hint") ?? "";
	quiz.attempts = parseAttempts(sections.get("attempts") ?? "");
	quiz.cycles = parseCycles(sections.get("cycles") ?? "");
	quiz.status =
		storedStatus === "mastered" ||
		(LEGACY_STATUSES.has(storedStatus) &&
			quiz.progress >= DEFAULT_QUIZ_SCHEDULE.masterySteps)
			? "mastered"
			: "active";
	return quiz;
}

function splitSections(block: string): Map<string, string> {
	const sections = new Map<string, string>();
	const heading = /^###\s+(question|answer|hint|attempts|cycles)\s*$/gim;
	const heads: { name: string; start: number; bodyStart: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = heading.exec(block)) !== null)
		heads.push({
			name: match[1].toLowerCase(),
			start: match.index,
			bodyStart: match.index + match[0].length,
		});
	for (let i = 0; i < heads.length; i++) {
		const head = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : block.length;
		sections.set(
			head.name,
			block.slice(head.bodyStart, end).replace(/^\n+|\s+$/g, "")
		);
	}
	return sections;
}

function parseAttempts(body: string): QuizAttempt[] {
	const attempts: QuizAttempt[] = [];
	for (const raw of body.split("\n")) {
		const parts = raw.replace(/^\s*-\s*/, "").split("|").map((s) => s.trim());
		if (parts.length !== 4) continue;
		const result = parts[1] as QuizResult;
		const progress = /^(\d+)>(\d+)$/.exec(parts[3]);
		if (!RESULTS.has(result) || !progress) continue;
		attempts.push({
			at: parts[0],
			result,
			early: parts[2] === "early",
			progressBefore: Number(progress[1]),
			progressAfter: Number(progress[2]),
		});
	}
	return attempts;
}

function parseCycles(body: string): MasteryCycle[] {
	const cycles: MasteryCycle[] = [];
	for (const raw of body.split("\n")) {
		const parts = raw.replace(/^\s*-\s*/, "").split("|").map((s) => s.trim());
		if (!parts[0]) continue;
		cycles.push({
			startedAt: parts[0],
			completedAt: parts[1] || undefined,
		});
	}
	return cycles;
}

export function serializeQuizzesFile(
	quizzes: Map<string, QuizEntry>
): string {
	const parts = [QUIZZES_HEADER, ""];
	for (const id of [...quizzes.keys()].sort()) {
		const quiz = quizzes.get(id);
		if (!quiz) continue;
		parts.push(`## ${id}`);
		parts.push(`sourceEvId: ${quiz.sourceEvId}`);
		parts.push(`kind: ${quiz.kind}`);
		parts.push(`status: ${quiz.status}`);
		parts.push(`progress: ${quiz.progress}`);
		if (quiz.nextReview) parts.push(`nextReview: ${quiz.nextReview}`);
		parts.push(`created: ${quiz.created}`);
		parts.push(`updated: ${quiz.updated}`);
		parts.push("");
		pushSection(parts, "Question", quiz.question);
		pushSection(parts, "Answer", quiz.answer);
		if (quiz.hint) pushSection(parts, "Hint", quiz.hint);
		if (quiz.attempts.length) {
			parts.push("### Attempts");
			for (const attempt of quiz.attempts)
				parts.push(
					`- ${attempt.at} | ${attempt.result} | ${
						attempt.early ? "early" : "scheduled"
					} | ${attempt.progressBefore}>${attempt.progressAfter}`
				);
			parts.push("");
		}
		if (quiz.cycles.length) {
			parts.push("### Cycles");
			for (const cycle of quiz.cycles)
				parts.push(`- ${cycle.startedAt} | ${cycle.completedAt ?? ""}`);
			parts.push("");
		}
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}

function pushSection(parts: string[], name: string, body: string): void {
	parts.push(`### ${name}`);
	parts.push(body.trim());
	parts.push("");
}
