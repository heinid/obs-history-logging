import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { scanVault } from "./scan";
import { eventIdsForQuery } from "./profile-events";
import { Profile } from "./profiles";
import { QuizEntry, isQuizReady } from "./quiz";
import { quizSchedule } from "./quiz-display";
import { QuizSessionModal } from "./quiz-session-modal";
import { DeckStats, quizDeckStats } from "./deck-stats";
import { EntityEntry, orderLangs } from "./db-format";
import { ReciteDeck, reciteDeckCandidates } from "./recite-format";
import { ReciteSessionModal } from "./recite-session-modal";
import { ReciteDeckModal } from "./recite-deck-modal";
import { langDisplayName } from "./quiz-render";

export const RECITATION_VIEW_TYPE = "history-logging-recitation";

interface EventDeck {
	profile: Profile;
	dueIds: string[];
	activeIds: string[];
	stats: DeckStats;
}

// The recitation hub: a wall of event-quiz decks (one per profile) plus
// entity-recitation direction decks. Aggregation is on-demand — a full scan
// happens each reload; the view is opened rarely and refreshed explicitly.
export class RecitationView extends ItemView {
	private eventDecks: EventDeck[] = [];
	private reciteDecks: ReciteDeck[] = [];
	private entities = new Map<string, EntityEntry>();

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return RECITATION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "背诵";
	}

	getIcon(): string {
		return "brain-circuit";
	}

	async onOpen(): Promise<void> {
		await this.reload();
	}

	async reload(): Promise<void> {
		const [entries, profiles, quizzes, reciteDecks, entities] =
			await Promise.all([
				scanVault(
					this.app,
					this.plugin.store,
					this.plugin.settings.dataFolder
				),
				this.plugin.store.readProfiles(),
				this.plugin.store.readQuizzes(),
				this.plugin.store.readReciteDecks(),
				this.plugin.store.readEntities(),
			]);
		this.reciteDecks = reciteDecks;
		this.entities = entities;

		const schedule = quizSchedule(this.plugin.settings);
		const now = new Date();
		const byEvent = new Map<string, QuizEntry[]>();
		for (const q of quizzes.values()) {
			const list = byEvent.get(q.sourceEvId) ?? [];
			list.push(q);
			byEvent.set(q.sourceEvId, list);
		}

		this.eventDecks = profiles.map((profile) => {
			const eventIds = eventIdsForQuery(this.app, entries, profile.match);
			const deckQuizzes: QuizEntry[] = [];
			for (const id of eventIds)
				for (const q of byEvent.get(id) ?? []) deckQuizzes.push(q);
			const stats = quizDeckStats(deckQuizzes, now, schedule);
			const active = deckQuizzes.filter((q) => q.status === "active");
			return {
				profile,
				stats,
				dueIds: active
					.filter((q) => isQuizReady(q, now, schedule))
					.map((q) => q.id),
				activeIds: active.map((q) => q.id),
			};
		});

		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-recitation-view");

		const toolbar = root.createDiv({ cls: "hl-recite-toolbar" });
		toolbar.createEl("h2", { text: "背诵" });
		const refresh = toolbar.createEl("button", { text: "刷新" });
		refresh.addEventListener("click", () => void this.reload());

		this.renderEventDecks(root);
		this.renderReciteDecks(root);
	}

	private renderEventDecks(root: HTMLElement): void {
		const section = root.createDiv({ cls: "hl-recite-section" });
		section.createEl("h3", { text: "事件背诵" });
		const wall = section.createDiv({ cls: "hl-deck-wall" });
		if (!this.eventDecks.length) {
			wall.createDiv({ cls: "hl-deck-empty", text: "还没有 profile。" });
			return;
		}
		for (const deck of this.eventDecks) this.renderEventDeck(wall, deck);
	}

	private renderEventDeck(wall: HTMLElement, deck: EventDeck): void {
		const total = deck.stats.active + deck.stats.mastered;
		const card = wall.createDiv({ cls: "hl-deck-card" });
		if (!total) card.addClass("hl-deck-empty-card");
		card.createDiv({ cls: "hl-deck-name", text: deck.profile.name });
		if (deck.profile.match)
			card.createDiv({
				cls: "hl-deck-match",
				text: deck.profile.match,
			});

		if (!total) {
			card.createDiv({
				cls: "hl-deck-meta",
				text: "0 道 Quiz · 去 Timeline 创建",
			});
			return;
		}

		const meta = card.createDiv({ cls: "hl-deck-meta" });
		meta.createSpan({
			text: `在学 ${deck.stats.active} · 学过 ${deck.stats.mastered}`,
		});
		if (deck.stats.due > 0)
			card.createDiv({
				cls: "hl-deck-due",
				text: `今日到期 ${deck.stats.due}`,
			});
		if (deck.stats.lastReviewedAt)
			card.createDiv({
				cls: "hl-deck-last",
				text: `上次 ${relativeDay(deck.stats.lastReviewedAt)} · 记得 ${
					deck.stats.lastResults.remembered
				} / 模糊 ${deck.stats.lastResults.fuzzy} / 忘 ${
					deck.stats.lastResults.forgot
				}`,
			});

		const actions = card.createDiv({ cls: "hl-deck-actions" });
		const start = actions.createEl("button", {
			cls: "mod-cta",
			text: deck.stats.due > 0 ? `背诵到期 ${deck.stats.due}` : "无到期",
		});
		if (deck.stats.due > 0)
			start.addEventListener("click", () =>
				new QuizSessionModal(
					this.app,
					this.plugin,
					deck.dueIds
				).open()
			);
		else start.disabled = true;

		if (deck.activeIds.length) {
			const all = actions.createEl("button", {
				text: `全部在学 ${deck.activeIds.length}`,
			});
			all.addEventListener("click", () =>
				new QuizSessionModal(
					this.app,
					this.plugin,
					deck.activeIds
				).open()
			);
		}
	}

	private renderReciteDecks(root: HTMLElement): void {
		const section = root.createDiv({ cls: "hl-recite-section" });
		section.createEl("h3", { text: "词条背诵" });
		const wall = section.createDiv({ cls: "hl-deck-wall" });
		for (const deck of this.reciteDecks)
			this.renderReciteDeck(wall, deck);

		const add = wall.createDiv({ cls: "hl-deck-card hl-deck-add" });
		add.createDiv({ cls: "hl-deck-add-plus", text: "＋" });
		add.createDiv({ text: "新建方向" });
		add.addEventListener("click", () => this.editDeck(null));
	}

	private renderReciteDeck(wall: HTMLElement, deck: ReciteDeck): void {
		const candidates = reciteDeckCandidates(
			this.entities.values(),
			deck
		);
		const card = wall.createDiv({ cls: "hl-deck-card" });
		card.createDiv({ cls: "hl-deck-name", text: deck.name });
		card.createDiv({
			cls: "hl-deck-match",
			text: `${langDisplayName(deck.from)} → ${orderLangs(deck.to)
				.map(langDisplayName)
				.join(" / ")}`,
		});
		const scope: string[] = [];
		if (deck.tags.length) scope.push(deck.tags.join(", "));
		if (deck.types.length) scope.push(deck.types.join(", "));
		if (scope.length)
			card.createDiv({ cls: "hl-deck-scope", text: scope.join(" · ") });
		card.createDiv({
			cls: "hl-deck-meta",
			text: `${candidates.length} 个词条`,
		});

		const actions = card.createDiv({ cls: "hl-deck-actions" });
		const start = actions.createEl("button", {
			cls: "mod-cta",
			text: "开始背诵",
		});
		if (candidates.length)
			start.addEventListener("click", () =>
				new ReciteSessionModal(
					this.app,
					this.plugin,
					deck,
					candidates
				).open()
			);
		else start.disabled = true;
		const edit = actions.createEl("button", { text: "编辑" });
		edit.addEventListener("click", () => this.editDeck(deck));
	}

	private editDeck(existing: ReciteDeck | null): void {
		new ReciteDeckModal(
			this.app,
			this.plugin,
			existing,
			async (saved, remove) => {
				const decks = await this.plugin.store.readReciteDecks();
				const next = existing
					? decks.filter((d) => d.name !== existing.name)
					: decks;
				if (!remove) next.push(saved);
				await this.plugin.store.writeReciteDecks(next);
				new Notice(remove ? "已删除方向" : "已保存方向");
				await this.reload();
			}
		).open();
	}
}

function relativeDay(iso: string): string {
	const then = new Date(iso);
	const today = new Date();
	const days = Math.round(
		(today.setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) /
			86400000
	);
	if (days <= 0) return "今天";
	if (days === 1) return "昨天";
	if (days < 7) return `${days} 天前`;
	return then.toLocaleDateString();
}
