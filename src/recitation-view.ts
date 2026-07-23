import { ItemView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { scanVault } from "./scan";
import { eventIdsForQuery } from "./profile-events";
import { QuizEntry } from "./quiz";
import { nextClockDelay, quizSchedule } from "./quiz-display";
import { QuizPlayerPage } from "./quiz-player";
import { QuizWorkbench, WorkbenchDeck } from "./quiz-workbench";
import { QuizView } from "./quiz-views";
import { EventEntry } from "./types";
import { MapEntry } from "./maps-format";
import { DbColors, loadDbColors } from "./quiz-render";

export const RECITATION_VIEW_TYPE = "history-logging-recitation";

interface DynamicPart {
	el: HTMLElement;
	lastSig: string;
	signature(): string;
	update(el: HTMLElement): void;
}

type Page = { kind: "list" } | { kind: "player" };

// The recitation hub: a lexicon-style quiz workbench (views = decks, rows =
// management, deck overview one click away) with an in-view player. State
// refreshes on data-file changes (debounced); wall-clock changes (a short
// wait expiring, a countdown label ticking down) repaint only the affected
// fragments via precisely scheduled timers, so nothing flashes. A quiz
// coming off its short wait while the hub is the active view is consumed
// here (interjected into the running session or badged on the list)
// instead of raising the alarm modal.
export class RecitationView extends ItemView {
	private eventDecks: WorkbenchDeck[] = [];
	private quizzes = new Map<string, QuizEntry>();
	private events = new Map<string, EventEntry>();
	private maps = new Map<string, MapEntry>();
	private views: QuizView[] = [];
	private colors: DbColors = new Map();
	private byEvent = new Map<string, QuizEntry[]>();
	private page: Page = { kind: "list" };
	private player: QuizPlayerPage | null = null;
	private workbench: QuizWorkbench;
	private loading = false;
	private queueReload = debounce(() => void this.reload(), 1500, true);
	private clockTimer: number | null = null;
	private dynamicParts: DynamicPart[] = [];
	private dataSig = "";
	private needsRender = true;

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
		this.workbench = new QuizWorkbench({
			plugin,
			decks: () => this.eventDecks,
			quizzes: () => this.quizzes,
			events: () => this.events,
			maps: () => this.maps,
			colors: () => this.colors,
			views: () => this.views,
			saveViews: async (views) => {
				await this.plugin.store.writeQuizViews(views);
				this.views = views;
				this.needsRender = true;
				await this.reload();
			},
			startSession: (label, sessionIds, scopeIds, profileName) =>
				this.startQuizSession(
					label,
					sessionIds,
					scopeIds,
					profileName
				),
			onChanged: () => this.queueReload(),
			registerDynamic: (el, signature, update) =>
				this.registerDynamic(el, signature, update),
			rerender: () => {
				this.needsRender = false;
				this.render();
			},
		});
	}

	getViewType(): string {
		return RECITATION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Quiz";
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
		// Refresh the workbench numbers in place, but let the alarm modal
		// pop as well — a due short wait should interrupt browsing too.
		this.applyClockTick();
		return false;
	}

	async reload(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		try {
			const [entries, profiles, quizzes, maps, events, views, colors] =
				await Promise.all([
					scanVault(
						this.app,
						this.plugin.store,
						this.plugin.settings.dataFolder
					),
					this.plugin.store.readProfiles(),
					this.plugin.store.readQuizzes(),
					this.plugin.store.readMaps(),
					this.plugin.store.readEvents(),
					this.plugin.store.readQuizViews(),
					loadDbColors(this.plugin),
				]);
			this.quizzes = quizzes;
			this.events = events;
			this.maps = maps;
			this.views = views;
			this.colors = colors;

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

			this.eventDecks = profiles.map((profile) => {
				const eventIds = eventIdsForQuery(
					this.app,
					entries,
					profile.match
				);
				const seen = new Set<string>();
				const allIds: string[] = [];
				for (const id of eventIds)
					for (const q of this.byEvent.get(id) ?? [])
						if (!seen.has(q.id)) {
							seen.add(q.id);
							allIds.push(q.id);
						}
				return { profile, allIds };
			});
			this.workbench.revalidateSelection();
		} finally {
			this.loading = false;
		}
		// Any markdown edit anywhere in the vault lands here (debounced);
		// rebuilding the page for edits that didn't move any number is what
		// used to make the view flash. Skip the render when nothing changed.
		const sig = JSON.stringify({
			q: [...this.quizzes.entries()],
			v: this.views,
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
		const prevScroll = this.workbench.takeScrollReset()
			? 0
			: scroller?.scrollTop ?? 0;
		this.dynamicParts = [];
		root.empty();
		root.addClass("hl-recitation-view");
		this.workbench.render(root);
		this.restoreScroll(scroller, prevScroll);
		this.scheduleClockTick();
	}

	// The workbench's main column is the scroller; keep the user where they
	// were instead of snapping back to the top on refresh.
	private scrollEl(): HTMLElement | null {
		return (
			this.contentEl.querySelector<HTMLElement>(".hl-lex-main") ??
			this.contentEl
		);
	}

	private restoreScroll(el: HTMLElement | null, top: number): void {
		if (!el || top <= 0) return;
		const again = this.scrollEl();
		if (!again) return;
		again.scrollTop = top;
		window.requestAnimationFrame(() => {
			again.scrollTop = top;
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
}
