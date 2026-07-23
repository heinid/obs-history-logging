// Saved views of the quiz workbench, persisted in `quiz-views.md`. A view
// is a filter combination over the quiz pool — base timeline profile plus
// kind/status filters and display parameters. Views double as study decks:
// the filter result is the deck, no separate membership.
//
//   ## ローマ · 弱项 cloze
//   profile: ローマ史
//   kinds: cloze
//   status: active
//   group: state
//   sort: due

import { QuizKind, QuizStatus } from "./quiz";

export type QuizViewGroup = "state" | "kind" | "event" | "none";
export type QuizViewSort = "due" | "year" | "created";

export interface QuizView {
	name: string;
	// Base timeline profile scoping the pool ("" = all quizzes).
	profile: string;
	// Kind filter (empty = all kinds).
	kinds: QuizKind[];
	// Status filter ("" = both active and mastered).
	status: "" | QuizStatus;
	group: QuizViewGroup;
	sort: QuizViewSort;
	// Committed search-term chips (AND-combined substring matches).
	terms: string[];
}

export const QUIZ_VIEWS_HEADER = "# History Logging — quiz views";

const KINDS = new Set<QuizKind>(["year", "cloze", "qa", "map"]);
const GROUPS = new Set<QuizViewGroup>(["state", "kind", "event", "none"]);
const SORTS = new Set<QuizViewSort>(["due", "year", "created"]);

export function emptyQuizView(name = ""): QuizView {
	return {
		name,
		profile: "",
		kinds: [],
		status: "",
		group: "none",
		sort: "created",
		terms: [],
	};
}

export function parseQuizViewsFile(content: string): QuizView[] {
	const normalised = content.replace(/\r\n/g, "\n");
	const re = /^##\s+(.+?)\s*$/gm;
	const heads: { name: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null)
		heads.push({
			name: m[1],
			start: m.index,
			bodyStart: m.index + m[0].length,
		});
	const views: QuizView[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end =
			i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const block = normalised.slice(h.bodyStart, end);
		const view = emptyQuizView(h.name);
		for (const line of block.split("\n")) {
			const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
			if (!kv) continue;
			const value = kv[2].trim();
			if (kv[1] === "profile") view.profile = value;
			else if (kv[1] === "kinds")
				view.kinds = value
					.split(",")
					.map((k) => k.trim())
					.filter((k): k is QuizKind => KINDS.has(k as QuizKind));
			else if (
				kv[1] === "status" &&
				(value === "active" || value === "mastered")
			)
				view.status = value;
			else if (kv[1] === "group" && GROUPS.has(value as QuizViewGroup))
				view.group = value as QuizViewGroup;
			else if (kv[1] === "sort" && SORTS.has(value as QuizViewSort))
				view.sort = value as QuizViewSort;
			else if (kv[1] === "terms")
				view.terms = value
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
		}
		views.push(view);
	}
	return views;
}

export function serializeQuizViewsFile(views: QuizView[]): string {
	const parts = [QUIZ_VIEWS_HEADER, ""];
	for (const v of views) {
		parts.push(`## ${v.name}`);
		if (v.profile) parts.push(`profile: ${v.profile}`);
		if (v.kinds.length) parts.push(`kinds: ${v.kinds.join(", ")}`);
		if (v.status) parts.push(`status: ${v.status}`);
		if (v.group !== "none") parts.push(`group: ${v.group}`);
		if (v.sort !== "created") parts.push(`sort: ${v.sort}`);
		if (v.terms.length) parts.push(`terms: ${v.terms.join(", ")}`);
		parts.push("");
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}
