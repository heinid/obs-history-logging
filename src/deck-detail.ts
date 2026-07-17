// Deck detail pages inside the recitation hub: browse a deck's quizzes
// grouped by state (with revive for mastered ones), or a direction deck's
// candidate entities. Pure rendering — all mutation goes through the store.

import { setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import {
	QuizEntry,
	isQuizReady,
	isQuizWaiting,
	reviveQuiz,
} from "./quiz";
import { nextReviewLabel, quizSchedule } from "./quiz-display";
import { QuizPracticeModal } from "./quiz-modal";
import { EntityEntry, displayName } from "./db-format";
import { ReciteDeck } from "./recite-format";
import { langDisplayName } from "./quiz-render";

export interface DeckDetailCtx {
	plugin: HistoryLoggingPlugin;
	onBack(): void;
	onChanged(): void;
}

function header(
	root: HTMLElement,
	title: string,
	subtitle: string,
	ctx: DeckDetailCtx
): void {
	const top = root.createDiv({ cls: "hl-player-top" });
	const back = top.createEl("button", { cls: "hl-player-back" });
	setIcon(back, "arrow-left");
	back.createSpan({ text: "背诵" });
	back.addEventListener("click", () => ctx.onBack());
	const label = top.createDiv({ cls: "hl-detail-title" });
	label.createDiv({ text: title });
	if (subtitle)
		label.createDiv({ cls: "hl-deck-match", text: subtitle });
}

// Event deck: quizzes grouped 到期 / 短等待 / 在学 / 学过.
export function renderEventDeckDetail(
	root: HTMLElement,
	name: string,
	match: string,
	quizzes: QuizEntry[],
	ctx: DeckDetailCtx
): void {
	header(root, name, match, ctx);
	const schedule = quizSchedule(ctx.plugin.settings);
	const now = new Date();
	const groups: { label: string; items: QuizEntry[] }[] = [
		{ label: "到期", items: [] },
		{ label: "短等待", items: [] },
		{ label: "在学", items: [] },
		{ label: "学过", items: [] },
	];
	for (const quiz of quizzes) {
		if (quiz.status === "mastered") groups[3].items.push(quiz);
		else if (isQuizReady(quiz, now, schedule)) groups[0].items.push(quiz);
		else if (isQuizWaiting(quiz, now, schedule)) groups[1].items.push(quiz);
		else groups[2].items.push(quiz);
	}
	const body = root.createDiv({ cls: "hl-detail-body" });
	if (!quizzes.length) {
		body.createDiv({
			cls: "hl-deck-empty",
			text: "这个 deck 还没有 Quiz — 去 Timeline 的事件上创建。",
		});
		return;
	}
	for (const group of groups) {
		if (!group.items.length) continue;
		body.createDiv({
			cls: "hl-overline",
			text: `${group.label} · ${group.items.length}`,
		});
		const list = body.createDiv({ cls: "hl-detail-list" });
		for (const quiz of group.items)
			renderQuizRow(list, quiz, schedule, now, ctx);
	}
}

function renderQuizRow(
	list: HTMLElement,
	quiz: QuizEntry,
	schedule: ReturnType<typeof quizSchedule>,
	now: Date,
	ctx: DeckDetailCtx
): void {
	const row = list.createDiv({ cls: "hl-detail-row" });
	const text = row.createDiv({ cls: "hl-detail-row-text" });
	text.createDiv({
		cls: "hl-detail-row-title",
		text: quiz.question.trim() || `（${quiz.kind} 题）`,
	});
	const metaBits: string[] = [
		`掌握 ${quiz.progress}/${schedule.masterySteps}`,
	];
	if (quiz.cycles.length > 1) metaBits.push(`第 ${quiz.cycles.length} 轮`);
	const wait = nextReviewLabel(quiz, now, schedule);
	if (quiz.status === "active" && wait) metaBits.push(wait);
	text.createDiv({
		cls: "hl-detail-row-meta",
		text: metaBits.join(" · "),
	});
	const actions = row.createDiv({ cls: "hl-detail-row-actions" });
	if (quiz.status === "mastered") {
		const revive = actions.createEl("button", { text: "重新学习" });
		revive.addEventListener("click", (ev) => {
			ev.stopPropagation();
			void (async () => {
				await ctx.plugin.store.upsertQuiz(reviveQuiz(quiz));
				await ctx.plugin.refreshTimelines();
				ctx.onChanged();
			})();
		});
	}
	row.addEventListener("click", () =>
		new QuizPracticeModal(ctx.plugin.app, ctx.plugin, quiz.id, () =>
			ctx.onChanged()
		).open()
	);
}

// Direction deck: candidate entities with their per-language spellings.
export function renderReciteDeckDetail(
	root: HTMLElement,
	deck: ReciteDeck,
	candidates: EntityEntry[],
	ctx: DeckDetailCtx
): void {
	const direction = `${langDisplayName(deck.from)} → ${deck.to
		.map(langDisplayName)
		.join(" / ")}`;
	header(root, deck.name, direction, ctx);
	const body = root.createDiv({ cls: "hl-detail-body" });
	body.createDiv({
		cls: "hl-overline",
		text: `词条 · ${candidates.length}`,
	});
	if (!candidates.length) {
		body.createDiv({
			cls: "hl-deck-empty",
			text: "没有符合这个方向的词条。",
		});
		return;
	}
	const list = body.createDiv({ cls: "hl-detail-list" });
	for (const entity of candidates) {
		const row = list.createDiv({ cls: "hl-detail-row" });
		const text = row.createDiv({ cls: "hl-detail-row-text" });
		text.createDiv({
			cls: "hl-detail-row-title",
			text: displayName(entity),
		});
		const variants = entity.labels
			.filter((l) => l.text.trim() && l.lang !== deck.from)
			.map((l) => l.text)
			.join(" · ");
		if (variants)
			text.createDiv({ cls: "hl-detail-row-meta", text: variants });
		row.addEventListener("click", () =>
			void ctx.plugin.openEntityView(entity.id)
		);
	}
}
