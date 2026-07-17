import { ItemView, Notice, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { scanVault } from "./scan";
import { eventIdsForQuery } from "./profile-events";
import { Profile } from "./profiles";
import { QuizEntry, isQuizReady, isQuizWaiting } from "./quiz";
import { nextReviewLabel, quizSchedule } from "./quiz-display";
import {
	DeckStats,
	quizDeckStats,
	quizOverviewStats,
} from "./deck-stats";
import { EntityEntry, orderLangs } from "./db-format";
import { ReciteDeck, reciteDeckCandidates } from "./recite-format";
import { ReciteDeckModal } from "./recite-deck-modal";
import { langDisplayName } from "./quiz-render";
import { QuizPlayerPage } from "./quiz-player";
import { RecitePlayerPage } from "./recite-player";
import {
	renderEventDeckDetail,
	renderReciteDeckDetail,
} from "./deck-detail";

export const RECITATION_VIEW_TYPE = "history-logging-recitation";

interface EventDeck {
	profile: Profile;
	dueIds: string[];
	activeIds: string[];
	allIds: string[];
	stats: DeckStats;
}

type Page =
	| { kind: "list" }
	| { kind: "event-detail"; profile: string }
	| { kind: "recite-detail"; deck: string }
	| { kind: "player" };

// The recitation hub: deck wall → deck detail → in-view player. State
// refreshes on data-file changes (debounced) and a slow tick while visible,
// so the manual reload button is gone. A quiz of the deck coming off its
// short wait while the hub is the active view is consumed here (interjected
// into the running session or badged on the wall) instead of raising the
// alarm modal.
export class RecitationView extends ItemView {
	private eventDecks: EventDeck[] = [];
	private reciteDecks: ReciteDeck[] = [];
	private entities = new Map<string, EntityEntry>();
	private quizzes = new Map<string, QuizEntry>();
	private byEvent = new Map<string, QuizEntry[]>();
	private page: Page = { kind: "list" };
	private player: QuizPlayerPage | RecitePlayerPage | null = null;
	private loading = false;
	private queueReload = debounce(() => void this.reload(), 1500, true);

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
		// Any vault edit may move deck numbers (events live in notes, quiz
		// state in the data folder); reload is cheap and debounced.
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (f instanceof TFile && f.extension === "md")
					this.queueReload();
			})
		);
		this.registerEvent(this.app.vault.on("delete", () => this.queueReload()));
		this.registerEvent(this.app.vault.on("rename", () => this.queueReload()));
		// Short waits expire without a file change; tick the wall clock.
		this.registerInterval(
			window.setInterval(() => {
				if (this.page.kind !== "player") this.render();
			}, 30_000)
		);
		// A session left in the background may have had cards answered
		// elsewhere (alarm modal, timeline); revalidate on return.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (
					leaf === this.leaf &&
					this.player instanceof QuizPlayerPage
				)
					void this.player.revalidate();
			})
		);
		await this.reload();
	}

	onunload(): void {
		this.player?.unmount();
	}

	// A short-wait quiz came due while this view is active. Returns true when
	// the hub consumed it (no alarm modal wanted).
	handleDueQuiz(quiz: QuizEntry): boolean {
		if (
			this.page.kind === "player" &&
			this.player instanceof QuizPlayerPage
		) {
			if (this.player.handleDueQuiz(quiz)) return true;
		}
		// On the wall or detail pages the refreshed numbers and alarm badges
		// are the notification; no popup while the user is already here.
		this.queueReload();
		return this.page.kind !== "player";
	}

	async reload(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		try {
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
			this.quizzes = quizzes;

			this.byEvent = new Map();
			for (const q of quizzes.values()) {
				const list = this.byEvent.get(q.sourceEvId) ?? [];
				list.push(q);
				this.byEvent.set(q.sourceEvId, list);
			}

			const schedule = quizSchedule(this.plugin.settings);
			const now = new Date();
			this.eventDecks = profiles.map((profile) => {
				const eventIds = eventIdsForQuery(
					this.app,
					entries,
					profile.match
				);
				const deckQuizzes: QuizEntry[] = [];
				for (const id of eventIds)
					for (const q of this.byEvent.get(id) ?? [])
						deckQuizzes.push(q);
				const active = deckQuizzes.filter(
					(q) => q.status === "active"
				);
				return {
					profile,
					stats: quizDeckStats(deckQuizzes, now, schedule),
					dueIds: active
						.filter((q) => isQuizReady(q, now, schedule))
						.map((q) => q.id),
					activeIds: active.map((q) => q.id),
					allIds: deckQuizzes.map((q) => q.id),
				};
			});
		} finally {
			this.loading = false;
		}
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		if (this.page.kind === "player" && this.player) return;
		root.empty();
		root.addClass("hl-recitation-view");
		if (this.page.kind === "event-detail") {
			const deck = this.eventDecks.find(
				(d) =>
					this.page.kind === "event-detail" &&
					d.profile.name === this.page.profile
			);
			if (deck) {
				renderEventDeckDetail(
					root,
					deck.profile.name,
					deck.profile.match,
					deck.allIds
						.map((id) => this.quizzes.get(id))
						.filter((q): q is QuizEntry => !!q),
					{
						plugin: this.plugin,
						onBack: () => this.showList(),
						onChanged: () => this.queueReload(),
					}
				);
				return;
			}
			this.page = { kind: "list" };
		}
		if (this.page.kind === "recite-detail") {
			const deck = this.reciteDecks.find(
				(d) =>
					this.page.kind === "recite-detail" &&
					d.name === this.page.deck
			);
			if (deck) {
				renderReciteDeckDetail(
					root,
					deck,
					reciteDeckCandidates(this.entities.values(), deck),
					{
						plugin: this.plugin,
						onBack: () => this.showList(),
						onChanged: () => this.queueReload(),
					}
				);
				return;
			}
			this.page = { kind: "list" };
		}
		this.renderList(root);
	}

	private showList(): void {
		this.player?.unmount();
		this.player = null;
		this.page = { kind: "list" };
		void this.reload();
	}

	private startQuizSession(
		label: string,
		sessionIds: string[],
		scopeIds: string[]
	): void {
		if (!sessionIds.length) return;
		this.player?.unmount();
		const player = new QuizPlayerPage(
			this.plugin,
			label,
			sessionIds,
			new Set(scopeIds),
			() => this.showList()
		);
		this.player = player;
		this.page = { kind: "player" };
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-recitation-view");
		player.mount(root.createDiv());
		void player.load();
	}

	private startReciteSession(
		deck: ReciteDeck,
		candidates: EntityEntry[]
	): void {
		if (!candidates.length) return;
		this.player?.unmount();
		const player = new RecitePlayerPage(
			this.plugin,
			deck,
			candidates,
			() => this.showList()
		);
		this.player = player;
		this.page = { kind: "player" };
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-recitation-view");
		player.mount(root.createDiv());
	}

	// Keyboard shortcuts pass through to the running player.
	onKeyDown = (ev: KeyboardEvent): void => {
		if (this.page.kind !== "player" || !this.player) return;
		const target = ev.target as HTMLElement;
		if (target.closest("input, textarea, [contenteditable]")) return;
		if (this.player.handleKey(ev)) ev.preventDefault();
	};

	onload(): void {
		super.onload();
		this.registerDomEvent(this.containerEl, "keydown", this.onKeyDown);
	}

	private renderList(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: "hl-recite-toolbar" });
		toolbar.createEl("h2", { text: "背诵" });

		this.renderOverview(root);
		this.renderEventDecks(root);
		this.renderReciteDecks(root);
	}

	private renderOverview(root: HTMLElement): void {
		const schedule = quizSchedule(this.plugin.settings);
		const now = new Date();
		const overview = quizOverviewStats(
			[...this.quizzes.values()],
			now,
			schedule
		);
		const bar = root.createDiv({ cls: "hl-recite-overview" });
		const item = (
			num: string,
			label: string,
			cls = ""
		): HTMLElement => {
			const box = bar.createDiv({ cls: `hl-overview-item ${cls}` });
			box.createDiv({ cls: "hl-overview-num", text: num });
			box.createDiv({ cls: "hl-overview-label", text: label });
			return box;
		};
		item(String(overview.dueNow), "现在可练", "is-due");
		let waitLabel = "短等待中";
		if (overview.nextWaitDue) {
			const probe: QuizEntry = {
				...[...this.quizzes.values()][0],
				status: "active",
				nextReview: overview.nextWaitDue,
			};
			const when = nextReviewLabel(probe, now, schedule);
			if (when) waitLabel = `短等待 · 最近 ${when}`;
		}
		item(String(overview.waiting), waitLabel, "is-wait");
		item(String(overview.reviewedToday), "今天已背");
		item(String(overview.upcoming), "未来到期");
		const spacer = bar.createDiv({ cls: "hl-overview-spacer" });
		void spacer;
		const allDue = [...this.quizzes.values()]
			.filter(
				(q) =>
					q.status === "active" && isQuizReady(q, now, schedule)
			)
			.map((q) => q.id);
		const start = bar.createEl("button", {
			cls: "mod-cta hl-overview-start",
			text: `开始今日背诵 · ${allDue.length}`,
		});
		if (allDue.length)
			start.addEventListener("click", () =>
				this.startQuizSession(
					"全部",
					allDue,
					[...this.quizzes.keys()]
				)
			);
		else start.disabled = true;
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
		const card = wall.createDiv({ cls: "hl-deck-card hl-deck-clickable" });
		if (!total) card.addClass("hl-deck-empty-card");
		const head = card.createDiv({ cls: "hl-deck-head" });
		head.createDiv({ cls: "hl-deck-name", text: deck.profile.name });
		if (deck.stats.due > 0)
			head.createSpan({
				cls: "hl-deck-badge",
				text: String(deck.stats.due),
			});
		else if (total && !deck.stats.waiting)
			head.createSpan({ cls: "hl-deck-check", text: "✓" });
		if (deck.stats.waiting > 0) {
			const waitingDue = this.deckWaitingDue(deck);
			head.createSpan({
				cls: waitingDue
					? "hl-deck-badge hl-deck-badge-alarm"
					: "hl-deck-badge hl-deck-badge-wait",
				text: `⏰ ${deck.stats.waiting}`,
			});
		}
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
			card.addEventListener("click", () => {
				this.page = {
					kind: "event-detail",
					profile: deck.profile.name,
				};
				this.render();
			});
			return;
		}

		this.renderProgressBar(card, deck.stats);

		const meta = card.createDiv({ cls: "hl-deck-meta" });
		meta.createSpan({
			text: `在学 ${deck.stats.active} · 学过 ${deck.stats.mastered}`,
		});
		if (deck.stats.lastReviewedAt) {
			const last = deck.stats.lastResults;
			meta.createSpan({
				cls: "hl-deck-last",
				text: `上次 ${relativeDay(deck.stats.lastReviewedAt)} · ${
					last.remembered
				}✓ ${last.forgot}✗`,
			});
		}

		const actions = card.createDiv({ cls: "hl-deck-actions" });
		const start = actions.createEl("button", {
			cls: "mod-cta",
			text:
				deck.stats.due > 0 ? `背诵到期 ${deck.stats.due}` : "无到期",
		});
		if (deck.stats.due > 0)
			start.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.startQuizSession(
					deck.profile.name,
					deck.dueIds,
					deck.allIds
				);
			});
		else start.disabled = true;
		if (deck.activeIds.length) {
			const all = actions.createEl("button", {
				text: `全部在学 ${deck.activeIds.length}`,
			});
			all.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.startQuizSession(
					deck.profile.name,
					deck.activeIds,
					deck.allIds
				);
			});
		}
		card.addEventListener("click", () => {
			this.page = { kind: "event-detail", profile: deck.profile.name };
			this.render();
		});
	}

	// Whether some short-wait card of the deck is already past due (a missed
	// alarm) rather than still counting down.
	private deckWaitingDue(deck: EventDeck): boolean {
		const now = Date.now();
		return deck.activeIds.some((id) => {
			const quiz = this.quizzes.get(id);
			if (!quiz?.nextReview) return false;
			return (
				isQuizWaiting(
					quiz,
					new Date(),
					quizSchedule(this.plugin.settings)
				) && Date.parse(quiz.nextReview) <= now
			);
		});
	}

	// Mastery distribution: mastered + one segment per progress step.
	private renderProgressBar(card: HTMLElement, stats: DeckStats): void {
		const total = stats.active + stats.mastered;
		if (!total) return;
		const bar = card.createDiv({ cls: "hl-deck-bar" });
		const seg = (cls: string, count: number): void => {
			if (!count) return;
			bar.createDiv({
				cls: `hl-deck-bar-seg ${cls}`,
			}).style.width = `${(count / total) * 100}%`;
		};
		seg("is-mastered", stats.mastered);
		for (let step = stats.progressDist.length - 1; step >= 0; step--)
			seg(`is-step-${Math.min(step, 3)}`, stats.progressDist[step]);
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
		const candidates = reciteDeckCandidates(this.entities.values(), deck);
		const card = wall.createDiv({ cls: "hl-deck-card hl-deck-clickable" });
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
			start.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.startReciteSession(deck, candidates);
			});
		else start.disabled = true;
		const edit = actions.createEl("button", { text: "编辑" });
		edit.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.editDeck(deck);
		});
		card.addEventListener("click", () => {
			this.page = { kind: "recite-detail", deck: deck.name };
			this.render();
		});
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
