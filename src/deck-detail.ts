// Deck detail pages inside the recitation hub: a summary card with direct
// practice entry, then the deck's quizzes grouped by state (with revive for
// mastered ones), or a direction deck's candidate entities. Pure rendering —
// all mutation goes through the store.

import { setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import {
	QuizEntry,
	QuizKind,
	isQuizReady,
	isQuizWaiting,
	reviveQuiz,
} from "./quiz";
import { nextReviewLabel, quizSchedule } from "./quiz-display";
import { QuizPracticeModal } from "./quiz-modal";
import { loadDbColors, renderQuizText } from "./quiz-render";
import { EntityEntry, displayName } from "./db-format";
import { ReciteDeck } from "./recite-format";
import { langDisplayName } from "./quiz-render";
import { DeckStats } from "./deck-stats";

export interface DeckDetailCtx {
	plugin: HistoryLoggingPlugin;
	onBack(): void;
	onChanged(): void;
}

export interface EventDeckDetailData {
	name: string;
	match: string;
	quizzes: QuizEntry[];
	stats: DeckStats;
	dueIds: string[];
	activeIds: string[];
	onStart(label: string, sessionIds: string[]): void;
	profileName: string;
}

const KIND_LABEL: Record<QuizKind, string> = {
	year: "年份",
	cloze: "填空",
	qa: "问答",
};

function header(root: HTMLElement, ctx: DeckDetailCtx): void {
	const top = root.createDiv({ cls: "hl-player-top" });
	const back = top.createEl("button", { cls: "hl-player-back" });
	setIcon(back, "arrow-left");
	back.createSpan({ text: "背诵" });
	back.addEventListener("click", () => ctx.onBack());
}

// Mastery distribution bar shared with the deck wall.
export function renderMasteryBar(
	parent: HTMLElement,
	stats: DeckStats
): void {
	const total = stats.active + stats.mastered;
	if (!total) return;
	const bar = parent.createDiv({ cls: "hl-deck-bar" });
	const seg = (cls: string, count: number): void => {
		if (!count) return;
		bar.createDiv({ cls: `hl-deck-bar-seg ${cls}` }).style.width = `${
			(count / total) * 100
		}%`;
	};
	seg("is-mastered", stats.mastered);
	for (let step = stats.progressDist.length - 1; step >= 0; step--)
		seg(`is-step-${Math.min(step, 3)}`, stats.progressDist[step]);
}

// Event deck: summary card + quizzes grouped 到期 / 短等待 / 在学 / 学过.
export async function renderEventDeckDetail(
	root: HTMLElement,
	data: EventDeckDetailData,
	ctx: DeckDetailCtx
): Promise<void> {
	header(root, ctx);
	const page = root.createDiv({ cls: "hl-detail-page" });
	const [events, colors] = await Promise.all([
		ctx.plugin.store.readEvents(),
		loadDbColors(ctx.plugin),
	]);

	const summary = page.createDiv({ cls: "hl-detail-summary" });
	const headRow = summary.createDiv({ cls: "hl-deck-head" });
	headRow.createDiv({ cls: "hl-deck-name", text: data.name });
	if (data.stats.due > 0)
		headRow.createSpan({
			cls: "hl-deck-badge",
			text: String(data.stats.due),
		});
	if (data.match)
		summary.createDiv({ cls: "hl-deck-match", text: data.match });
	renderMasteryBar(summary, data.stats);
	summary.createDiv({
		cls: "hl-deck-meta",
		text: `到期 ${data.stats.due} · 短等待 ${data.stats.waiting} · 在学 ${data.stats.active} · 学过 ${data.stats.mastered}`,
	});
	const actions = summary.createDiv({ cls: "hl-deck-actions" });
	const start = actions.createEl("button", {
		cls: "mod-cta",
		text: data.stats.due > 0 ? `背诵到期 ${data.stats.due}` : "无到期",
	});
	if (data.stats.due > 0)
		start.addEventListener("click", () =>
			data.onStart(data.name, data.dueIds)
		);
	else start.disabled = true;
	if (data.activeIds.length) {
		const all = actions.createEl("button", {
			text: `全部在学 ${data.activeIds.length}`,
		});
		all.addEventListener("click", () =>
			data.onStart(data.name, data.activeIds)
		);
	}

	const schedule = quizSchedule(ctx.plugin.settings);
	const now = new Date();
	const groups: { label: string; items: QuizEntry[] }[] = [
		{ label: "到期", items: [] },
		{ label: "短等待", items: [] },
		{ label: "在学", items: [] },
		{ label: "学过", items: [] },
	];
	for (const quiz of data.quizzes) {
		if (quiz.status === "mastered") groups[3].items.push(quiz);
		else if (isQuizReady(quiz, now, schedule)) groups[0].items.push(quiz);
		else if (isQuizWaiting(quiz, now, schedule))
			groups[1].items.push(quiz);
		else groups[2].items.push(quiz);
	}
	if (!data.quizzes.length) {
		page.createDiv({
			cls: "hl-deck-empty",
			text: "这个 deck 还没有 Quiz — 去 Timeline 的事件上创建。",
		});
		return;
	}
	for (const group of groups) {
		if (!group.items.length) continue;
		page.createDiv({
			cls: "hl-overline hl-detail-group-head",
			text: `${group.label} · ${group.items.length}`,
		});
		const list = page.createDiv({ cls: "hl-detail-list" });
		for (const quiz of group.items)
			renderQuizRow(
				list,
				quiz,
				events,
				colors,
				schedule,
				now,
				data.profileName,
				ctx
			);
	}
}

function renderQuizRow(
	list: HTMLElement,
	quiz: QuizEntry,
	events: Map<string, { tag?: string }>,
	colors: Map<string, string>,
	schedule: ReturnType<typeof quizSchedule>,
	now: Date,
	profileName: string,
	ctx: DeckDetailCtx
): void {
	const row = list.createDiv({ cls: "hl-detail-row" });
	row.createSpan({
		cls: `hl-detail-kind hl-detail-kind-${quiz.kind}`,
		text: KIND_LABEL[quiz.kind],
	});
	const text = row.createDiv({ cls: "hl-detail-row-text" });
	const title = text.createDiv({ cls: "hl-detail-row-title" });
	renderQuizText(
		ctx.plugin,
		quiz.question.trim() || `（${KIND_LABEL[quiz.kind]}题）`,
		title,
		colors
	);
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
	const tag = events.get(quiz.sourceEvId)?.tag;
	if (tag) {
		const reveal = actions.createEl("button", { cls: "hl-icon-btn" });
		setIcon(reveal, "gantt-chart");
		reveal.setAttr("aria-label", "在时间线上显示");
		reveal.addEventListener("click", (ev) => {
			ev.stopPropagation();
			void ctx.plugin.revealOnTimelineForProfile(
				profileName,
				quiz.sourceEvId,
				tag
			);
		});
	}
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
	onStart: () => void,
	ctx: DeckDetailCtx
): void {
	header(root, ctx);
	const page = root.createDiv({ cls: "hl-detail-page" });
	const summary = page.createDiv({ cls: "hl-detail-summary" });
	summary.createDiv({ cls: "hl-deck-name", text: deck.name });
	summary.createDiv({
		cls: "hl-deck-match",
		text: `${langDisplayName(deck.from)} → ${deck.to
			.map(langDisplayName)
			.join(" / ")}`,
	});
	summary.createDiv({
		cls: "hl-deck-meta",
		text: `${candidates.length} 个词条`,
	});
	const actions = summary.createDiv({ cls: "hl-deck-actions" });
	const start = actions.createEl("button", {
		cls: "mod-cta",
		text: "开始背诵",
	});
	if (candidates.length)
		start.addEventListener("click", () => onStart());
	else start.disabled = true;

	if (!candidates.length) {
		page.createDiv({
			cls: "hl-deck-empty",
			text: "没有符合这个方向的词条。",
		});
		return;
	}
	page.createDiv({
		cls: "hl-overline hl-detail-group-head",
		text: `词条 · ${candidates.length}`,
	});
	const list = page.createDiv({ cls: "hl-detail-list" });
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
