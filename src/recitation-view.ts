import { ItemView, Notice, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { scanVault } from "./scan";
import { eventIdsForQuery } from "./profile-events";
import { Profile } from "./profiles";
import { QuizEntry, isQuizReady, isQuizWaiting } from "./quiz";
import { nextClockDelay, nextReviewLabel, quizSchedule } from "./quiz-display";
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
	renderMasteryBar,
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

interface DynamicPart {
	el: HTMLElement;
	lastSig: string;
	signature(): string;
	update(el: HTMLElement): void;
}

type Page =
	| { kind: "list" }
	| { kind: "event-detail"; profile: string }
	| { kind: "recite-detail"; deck: string }
	| { kind: "player" };

// The recitation hub: deck wall → deck detail → in-view player. State
// refreshes on data-file changes (debounced); wall-clock changes (a short
// wait expiring, a countdown label ticking down) repaint only the affected
// fragments via precisely scheduled timers, so nothing flashes. A quiz of
// the deck coming off its short wait while the hub is the active view is
// consumed here (interjected into the running session or badged on the
// wall) instead of raising the alarm modal.
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
	private clockTimer: number | null = null;
	private dynamicParts: DynamicPart[] = [];
	private dataSig = "";
	private needsRender = true;

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
		if (this.clockTimer !== null) window.clearTimeout(this.clockTimer);
		this.player?.unmount();
	}

	// A fragment of the page whose content depends on the wall clock. When a
	// timer fires, only fragments whose signature changed are refilled; the
	// rest of the DOM is untouched, so refreshes don't flash or move focus.
	private registerDynamic(
		el: HTMLElement,
		signature: () => string,
		update: (el: HTMLElement) => void
	): void {
		this.dynamicParts.push({ el, signature, update, lastSig: signature() });
	}

	private applyClockTick(): void {
		if (this.page.kind !== "player") {
			this.dynamicParts = this.dynamicParts.filter(
				(p) => p.el.isConnected
			);
			for (const part of [...this.dynamicParts]) {
				const sig = part.signature();
				if (sig === part.lastSig) continue;
				part.lastSig = sig;
				part.el.empty();
				part.update(part.el);
			}
		}
		this.scheduleClockTick();
	}

	private scheduleClockTick(): void {
		if (this.clockTimer !== null) window.clearTimeout(this.clockTimer);
		this.clockTimer = null;
		if (this.page.kind === "player") return;
		const delay = nextClockDelay(
			this.quizzes.values(),
			quizSchedule(this.plugin.settings)
		);
		if (delay === null) return;
		this.clockTimer = window.setTimeout(
			() => this.applyClockTick(),
			delay
		);
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
		// are the notification; no popup while the user is already here. No
		// file changed, so patch the clock-dependent fragments in place.
		this.applyClockTick();
		return this.page.kind !== "player";
	}

	async reload(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		try {
			const [entries, profiles, quizzes, reciteDecks, entities, maps] =
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
					this.plugin.store.readMaps(),
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
			// Map quizzes belong to the events their map links; through those
			// events they join the same profile decks as ordinary quizzes.
			for (const q of quizzes.values())
				if (q.kind === "map" && q.sourceMapId)
					for (const evId of maps.get(q.sourceMapId)?.events ?? []) {
						const list = this.byEvent.get(evId) ?? [];
						list.push(q);
						this.byEvent.set(evId, list);
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
				const seen = new Set<string>();
				for (const id of eventIds)
					for (const q of this.byEvent.get(id) ?? [])
						if (!seen.has(q.id)) {
							seen.add(q.id);
							deckQuizzes.push(q);
						}
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
		// Any markdown edit anywhere in the vault lands here (debounced);
		// rebuilding the page for edits that didn't move any number is what
		// used to make the view flash. Skip the render when nothing changed.
		const sig = JSON.stringify({
			q: [...this.quizzes.entries()],
			r: this.reciteDecks,
			e: [...this.entities.entries()],
			d: this.eventDecks.map((d) => [
				d.profile.name,
				d.profile.match,
				d.allIds,
			]),
		});
		if (!this.needsRender && sig === this.dataSig) {
			this.applyClockTick();
			return;
		}
		this.dataSig = sig;
		this.needsRender = false;
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		if (this.page.kind === "player" && this.player) return;
		const scroller = this.scrollEl();
		const prevScroll = scroller?.scrollTop ?? 0;
		this.dynamicParts = [];
		root.empty();
		root.addClass("hl-recitation-view");
		if (this.page.kind === "event-detail") {
			const deck = this.eventDecks.find(
				(d) =>
					this.page.kind === "event-detail" &&
					d.profile.name === this.page.profile
			);
			if (deck) {
				void renderEventDeckDetail(
					root,
					{
						name: deck.profile.name,
						match: deck.profile.match,
						quizzes: deck.allIds
							.map((id) => this.quizzes.get(id))
							.filter((q): q is QuizEntry => !!q),
						stats: deck.stats,
						dueIds: deck.dueIds,
						activeIds: deck.activeIds,
						onStart: (label, ids) =>
							this.startQuizSession(
								label,
								ids,
								deck.allIds,
								deck.profile.name
							),
						profileName: deck.profile.name,
					},
					{
						plugin: this.plugin,
						onBack: () => this.showList(),
						onChanged: () => this.queueReload(),
						registerDynamic: (el, signature, update) =>
							this.registerDynamic(el, signature, update),
					}
				).then(() => {
					this.restoreScroll(scroller, prevScroll);
					this.scheduleClockTick();
				});
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
				const candidates = reciteDeckCandidates(
					this.entities.values(),
					deck
				);
				renderReciteDeckDetail(
					root,
					deck,
					candidates,
					() => this.startReciteSession(deck, candidates),
					{
						plugin: this.plugin,
						onBack: () => this.showList(),
						onChanged: () => this.queueReload(),
					}
				);
				this.restoreScroll(scroller, prevScroll);
				return;
			}
			this.page = { kind: "list" };
		}
		this.renderList(root);
		this.restoreScroll(scroller, prevScroll);
		this.scheduleClockTick();
	}

	// The recitation view rebuilds its content wholesale on refresh; keep the
	// user where they were instead of snapping back to the top.
	private scrollEl(): HTMLElement | null {
		let el: HTMLElement | null = this.contentEl;
		while (el) {
			if (el.scrollHeight > el.clientHeight + 1) {
				const oy = getComputedStyle(el).overflowY;
				if (oy === "auto" || oy === "scroll") return el;
			}
			el = el.parentElement;
		}
		return this.contentEl;
	}

	private restoreScroll(el: HTMLElement | null, top: number): void {
		if (!el || top <= 0) return;
		el.scrollTop = top;
		window.requestAnimationFrame(() => {
			el.scrollTop = top;
		});
	}

	private showList(): void {
		this.player?.unmount();
		this.player = null;
		this.page = { kind: "list" };
		this.needsRender = true;
		void this.reload();
	}

	private startQuizSession(
		label: string,
		sessionIds: string[],
		scopeIds: string[],
		profileName: string
	): void {
		if (!sessionIds.length) return;
		this.player?.unmount();
		const player = new QuizPlayerPage(
			this.plugin,
			label,
			sessionIds,
			new Set(scopeIds),
			profileName,
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

	// Keyboard shortcuts pass through to the running player. Listens on the
	// window (clicking a plain div doesn't focus the view container) and
	// only acts while this view is the active one.
	onKeyDown = (ev: KeyboardEvent): void => {
		if (this.app.workspace.getActiveViewOfType(RecitationView) !== this)
			return;
		if (this.page.kind !== "player" || !this.player) return;
		const target = ev.target as HTMLElement;
		if (target.closest("input, textarea, [contenteditable]")) return;
		if (this.player.handleKey(ev)) ev.preventDefault();
	};

	onload(): void {
		super.onload();
		this.registerDomEvent(window, "keydown", this.onKeyDown);
	}

	private renderList(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: "hl-recite-toolbar" });
		toolbar.createEl("h2", { text: "背诵" });
		const display = toolbar.createEl("select", {
			cls: "dropdown hl-recite-display",
		});
		display.setAttr("aria-label", "deck 显示方式");
		display.createEl("option", { value: "wall", text: "卡片墙" });
		display.createEl("option", { value: "list", text: "列表" });
		display.value = this.plugin.settings.reciteDeckDisplay;
		display.addEventListener("change", () => {
			this.plugin.settings.reciteDeckDisplay =
				display.value === "list" ? "list" : "wall";
			void this.plugin.saveSettings();
			this.render();
		});

		this.renderOverview(root);
		this.renderEventDecks(root);
		this.renderReciteDecks(root);
	}

	private overviewModel(now: Date): {
		dueNow: number;
		waiting: number;
		waitLabel: string;
		reviewedToday: number;
		upcoming: number;
		allDue: string[];
	} {
		const schedule = quizSchedule(this.plugin.settings);
		const overview = quizOverviewStats(
			[...this.quizzes.values()],
			now,
			schedule
		);
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
		const allDue = [...this.quizzes.values()]
			.filter(
				(q) =>
					q.status === "active" && isQuizReady(q, now, schedule)
			)
			.map((q) => q.id);
		return {
			dueNow: overview.dueNow,
			waiting: overview.waiting,
			waitLabel,
			reviewedToday: overview.reviewedToday,
			upcoming: overview.upcoming,
			allDue,
		};
	}

	private renderOverview(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "hl-recite-overview" });
		const fill = (el: HTMLElement): void => this.fillOverview(el);
		fill(bar);
		this.registerDynamic(
			bar,
			() => {
				const m = this.overviewModel(new Date());
				return [
					m.dueNow,
					m.waiting,
					m.waitLabel,
					m.reviewedToday,
					m.upcoming,
					m.allDue.length,
				].join("|");
			},
			fill
		);
	}

	private fillOverview(bar: HTMLElement): void {
		const m = this.overviewModel(new Date());
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
		item(String(m.dueNow), "现在可练", "is-due");
		item(String(m.waiting), m.waitLabel, "is-wait");
		item(String(m.reviewedToday), "今天已背");
		item(String(m.upcoming), "未来到期");
		bar.createDiv({ cls: "hl-overview-spacer" });
		const start = bar.createEl("button", {
			cls: "mod-cta hl-overview-start",
			text: `开始今日背诵 · ${m.allDue.length}`,
		});
		if (m.allDue.length)
			start.addEventListener("click", () =>
				this.startQuizSession(
					"全部",
					m.allDue,
					[...this.quizzes.keys()],
					""
				)
			);
		else start.disabled = true;
	}

	private renderEventDecks(root: HTMLElement): void {
		const section = root.createDiv({ cls: "hl-recite-section" });
		section.createEl("h3", { text: "事件背诵" });
		const wall = section.createDiv({ cls: this.wallCls() });
		if (!this.eventDecks.length) {
			wall.createDiv({ cls: "hl-deck-empty", text: "还没有 profile。" });
			return;
		}
		for (const deck of this.eventDecks) this.renderEventDeck(wall, deck);
	}

	// The deck's due/waiting numbers drift with the wall clock; recompute
	// them from the live quiz map so clock-tick refills stay accurate.
	private deckNow(deck: EventDeck, now: Date): EventDeck {
		const schedule = quizSchedule(this.plugin.settings);
		const quizzes = deck.allIds
			.map((id) => this.quizzes.get(id))
			.filter((q): q is QuizEntry => !!q);
		const active = quizzes.filter((q) => q.status === "active");
		return {
			profile: deck.profile,
			stats: quizDeckStats(quizzes, now, schedule),
			dueIds: active
				.filter((q) => isQuizReady(q, now, schedule))
				.map((q) => q.id),
			activeIds: active.map((q) => q.id),
			allIds: deck.allIds,
		};
	}

	private deckSignature(deck: EventDeck): string {
		return [
			deck.stats.due,
			deck.stats.waiting,
			this.deckWaitingDue(deck),
			deck.stats.active,
			deck.stats.mastered,
			deck.stats.lastReviewedAt
				? relativeDay(deck.stats.lastReviewedAt)
				: "",
		].join("|");
	}

	private renderEventDeck(wall: HTMLElement, deck: EventDeck): void {
		const total = deck.stats.active + deck.stats.mastered;
		const card = wall.createDiv({ cls: "hl-deck-card hl-deck-clickable" });
		if (!total) card.addClass("hl-deck-empty-card");
		card.addEventListener("click", () => {
			this.page = { kind: "event-detail", profile: deck.profile.name };
			this.render();
		});
		const fill = (el: HTMLElement): void =>
			this.fillEventDeck(el, this.deckNow(deck, new Date()));
		fill(card);
		if (total)
			this.registerDynamic(
				card,
				() => this.deckSignature(this.deckNow(deck, new Date())),
				fill
			);
	}

	private fillEventDeck(card: HTMLElement, deck: EventDeck): void {
		const total = deck.stats.active + deck.stats.mastered;
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
			return;
		}

		renderMasteryBar(card, deck.stats);

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
					deck.allIds,
					deck.profile.name
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
					deck.allIds,
					deck.profile.name
				);
			});
		}
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

	private renderReciteDecks(root: HTMLElement): void {
		const section = root.createDiv({ cls: "hl-recite-section" });
		section.createEl("h3", { text: "词条背诵" });
		const wall = section.createDiv({ cls: this.wallCls() });
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

	private wallCls(): string {
		return this.plugin.settings.reciteDeckDisplay === "list"
			? "hl-deck-wall is-list"
			: "hl-deck-wall";
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
