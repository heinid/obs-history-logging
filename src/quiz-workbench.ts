// The quiz workbench inside the recitation hub, built on the lexicon tab's
// design language: a left rail (search / built-in timeline views / saved
// views / kind & status facets), a quiet toolrow (grouping · sort · save /
// deck overview), a study strip (due / waiting / active / mastered + start),
// and quiz rows that carry the management actions themselves. A view IS a
// deck — the filter result is the study scope, no separate membership. The
// deck overview page keeps the old wall reachable in one click.

import { Menu, Notice, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { Profile } from "./profiles";
import {
	QuizEntry,
	QuizKind,
	isQuizReady,
	isQuizWaiting,
	quizSection,
	reviveQuiz,
} from "./quiz";
import {
	nextReviewLabel,
	quizAnswer,
	quizQuestion,
	quizSchedule,
} from "./quiz-display";
import { DeckStats, quizDeckStats } from "./deck-stats";
import { QuizPracticeModal } from "./quiz-modal";
import { ConfirmModal, NameModal } from "./name-modal";
import { DbColors, renderQuizText } from "./quiz-render";
import { EventEntry } from "./types";
import { MapEntry, mapDisplayTitle } from "./maps-format";
import { MapModal } from "./map-modal";
import { describeYear, parseYearTag } from "./year-tag";
import { renderMasteryBar } from "./deck-detail";
import {
	QuizView,
	QuizViewGroup,
	QuizViewSort,
	emptyQuizView,
} from "./quiz-views";

export interface WorkbenchDeck {
	profile: Profile;
	allIds: string[];
}

export interface QuizWorkbenchCtx {
	plugin: HistoryLoggingPlugin;
	decks(): WorkbenchDeck[];
	quizzes(): Map<string, QuizEntry>;
	events(): Map<string, EventEntry>;
	maps(): Map<string, MapEntry>;
	colors(): DbColors;
	views(): QuizView[];
	saveViews(views: QuizView[]): Promise<void>;
	startSession(
		label: string,
		sessionIds: string[],
		scopeIds: string[],
		profileName: string
	): void;
	onChanged(): void;
	registerDynamic(
		el: HTMLElement,
		signature: () => string,
		update: (el: HTMLElement) => void
	): void;
	rerender(): void;
}

type StudyFilter =
	| null
	| "due"
	| "fresh"
	| "waiting"
	| "active"
	| "mastered";

const KIND_LABEL: Record<QuizKind, string> = {
	year: "YEAR",
	cloze: "CLOZE",
	qa: "Q&A",
	map: "地图",
};

const GROUP_NAMES: Record<QuizViewGroup, string> = {
	state: "按状态分组",
	kind: "按题型分组",
	event: "按事件分组",
	none: "不分组",
};

const SORT_NAMES: Record<QuizViewSort, string> = {
	due: "到期优先",
	year: "按年代",
	created: "按创建时间",
};

export class QuizWorkbench {
	// null = the whole pool; otherwise a built-in profile or saved view name.
	private selected: string | null = null;
	private selectedCustom = false;
	private draft: QuizView = emptyQuizView();
	private search = "";
	private studyFilter: StudyFilter = null;
	// Created sort defaults to newest first; other sorts start ascending.
	private sortDesc = true;
	private overview = false;
	private revealed = new Set<string>();

	constructor(private ctx: QuizWorkbenchCtx) {}

	private schedule(): ReturnType<typeof quizSchedule> {
		return quizSchedule(this.ctx.plugin.settings);
	}

	// ── selection ──

	private boundView(): QuizView | null {
		if (!this.selected || !this.selectedCustom) return null;
		return (
			this.ctx.views().find((v) => v.name === this.selected) ?? null
		);
	}

	private selectPool(): void {
		this.scrollResetNext = true;
		this.selected = null;
		this.selectedCustom = false;
		this.draft = emptyQuizView();
		this.studyFilter = null;
		this.sortDesc = this.draft.sort === "created";
		this.overview = false;
		this.ctx.rerender();
	}

	private selectProfile(name: string): void {
		this.scrollResetNext = true;
		this.selected = name;
		this.selectedCustom = false;
		this.draft = { ...emptyQuizView(), profile: name };
		this.studyFilter = null;
		this.sortDesc = this.draft.sort === "created";
		this.overview = false;
		this.ctx.rerender();
	}

	private selectCustom(view: QuizView): void {
		this.scrollResetNext = true;
		this.selected = view.name;
		this.selectedCustom = true;
		this.draft = {
			...view,
			kinds: [...view.kinds],
			terms: [...view.terms],
		};
		this.studyFilter = null;
		this.sortDesc = this.draft.sort === "created";
		this.overview = false;
		this.ctx.rerender();
	}

	// Restore selection after a data reload; a deleted view falls back to
	// the whole pool.
	revalidateSelection(): void {
		if (!this.selected) return;
		const pool = this.selectedCustom
			? this.ctx.views().some((v) => v.name === this.selected)
			: this.ctx
					.decks()
					.some((d) => d.profile.name === this.selected);
		if (!pool) {
			this.selected = null;
			this.selectedCustom = false;
			this.draft = emptyQuizView();
		}
	}

	private dirty(): boolean {
		const bound = this.boundView();
		if (bound)
			return (
				JSON.stringify({ ...this.draft, name: "" }) !==
					JSON.stringify({ ...bound, name: "" }) ||
				this.search !== ""
			);
		// A built-in profile view (or the whole pool) is "clean" when no
		// extra filter sits on top of it.
		return (
			this.draft.kinds.length > 0 ||
			this.draft.status !== "" ||
			this.draft.terms.length > 0 ||
			this.search !== ""
		);
	}

	// ── filtering ──

	private quizzesForProfile(profile: string): QuizEntry[] {
		if (!profile) return [...this.ctx.quizzes().values()];
		const deck = this.ctx
			.decks()
			.find((d) => d.profile.name === profile);
		if (!deck) return [];
		const map = this.ctx.quizzes();
		return deck.allIds
			.map((id) => map.get(id))
			.filter((q): q is QuizEntry => !!q);
	}

	private quizzesForView(view: QuizView): QuizEntry[] {
		let out = this.quizzesForProfile(view.profile);
		if (view.kinds.length)
			out = out.filter((q) => view.kinds.includes(q.kind));
		if (view.status)
			out = out.filter((q) => q.status === view.status);
		return out;
	}

	private searchText(q: QuizEntry): string {
		const event = this.ctx.events().get(q.sourceEvId);
		const map = q.sourceMapId
			? this.ctx.maps().get(q.sourceMapId)
			: undefined;
		return `${q.question} ${q.answer} ${q.hint} ${
			event?.summary ?? ""
		} ${event?.tag ?? ""} ${map?.title ?? ""}`.toLowerCase();
	}

	// The list as filtered by the desk (view + facets + search), before the
	// study-strip segment filter.
	private filtered(): QuizEntry[] {
		let out = this.quizzesForView(this.draft);
		const queries = [...this.draft.terms, this.search.trim()]
			.map((t) => t.toLowerCase())
			.filter(Boolean);
		for (const query of queries)
			out = out.filter((q) => this.searchText(q).includes(query));
		return out;
	}

	// The next render starts at the top of the list (set when the study
	// filter changes, consumed by the hosting view's scroll restore).
	scrollResetNext = false;

	takeScrollReset(): boolean {
		const v = this.scrollResetNext;
		this.scrollResetNext = false;
		return v;
	}

	private section(
		q: QuizEntry,
		now: Date,
		schedule: ReturnType<typeof quizSchedule>
	): Exclude<StudyFilter, null> {
		return quizSection(q, now, schedule);
	}

	private listed(): QuizEntry[] {
		const out = this.filtered();
		if (!this.studyFilter) return out;
		const now = new Date();
		const schedule = this.schedule();
		return out.filter((q) => {
			if (!this.studyFilter) return true;
			return this.section(q, now, schedule) === this.studyFilter;
		});
	}

	// ── render ──

	render(root: HTMLElement): void {
		const shell = root.createDiv({ cls: "hl-lex hl-qd" });
		if (this.overview) {
			this.renderOverview(shell);
			return;
		}
		this.renderSidebar(shell.createDiv({ cls: "hl-lex-side" }));
		this.renderMain(shell.createDiv({ cls: "hl-lex-col" }));
		this.renderSwitchFab(shell);
	}

	// ── sidebar ──

	private renderSidebar(side: HTMLElement): void {
		const searchWrap = side.createDiv({ cls: "hl-lex-search" });
		const searchIcon = searchWrap.createSpan({
			cls: "hl-lex-search-icon",
		});
		setIcon(searchIcon, "search");
		const search = searchWrap.createEl("input", {
			attr: { type: "search", placeholder: "搜索题面 / 答案…" },
		});
		search.value = this.search;
		search.addEventListener("keydown", (ev) => {
			if (ev.key !== "Enter") return;
			const term = search.value.trim();
			if (!term) return;
			ev.preventDefault();
			if (!this.draft.terms.includes(term))
				this.draft.terms.push(term);
			this.search = "";
			search.value = "";
			this.ctx.rerender();
		});
		let timer = 0;
		search.addEventListener("input", () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				this.search = search.value.trim();
				this.ctx.rerender();
				const again =
					side.ownerDocument.querySelector<HTMLInputElement>(
						".hl-qd .hl-lex-search input"
					);
				if (again) {
					again.focus();
					again.setSelectionRange(
						again.value.length,
						again.value.length
					);
				}
			}, 250);
		});

		const now = new Date();
		const schedule = this.schedule();
		const dueCount = (quizzes: QuizEntry[]): number =>
			quizzes.filter(
				(q) =>
					q.status === "active" && isQuizReady(q, now, schedule)
			).length;

		const sideItem = (
			name: string,
			on: boolean,
			count: number,
			due: number,
			onClick: () => void,
			onCtx?: (ev: MouseEvent) => void
		): void => {
			const item = side.createDiv({
				cls: `hl-lex-side-item${on ? " is-on" : ""}`,
			});
			item.createSpan({ cls: "hl-lex-side-name", text: name });
			if (due > 0)
				item.createSpan({
					cls: "hl-lex-side-due",
					text: String(due),
				});
			item.createSpan({
				cls: "hl-lex-side-cnt",
				text: String(count),
			});
			item.addEventListener("click", onClick);
			if (onCtx) item.addEventListener("contextmenu", onCtx);
		};

		// built-in timeline views (= profiles), with a «+» to create a real
		// timeline profile right here
		const builtinLabel = side.createDiv({
			cls: "hl-lex-side-label hl-qd-side-label",
		});
		builtinLabel.createSpan({ text: "内置视图 · 时间线" });
		const addProfile = builtinLabel.createSpan({ cls: "hl-qd-side-add" });
		setIcon(addProfile, "plus");
		addProfile.setAttr("aria-label", "新建时间线 profile");
		addProfile.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.createProfile();
		});

		const all = [...this.ctx.quizzes().values()];
		sideItem(
			"全部 Quiz",
			this.selected === null,
			all.length,
			dueCount(all),
			() => this.selectPool()
		);
		for (const deck of this.ctx.decks()) {
			const quizzes = this.quizzesForProfile(deck.profile.name);
			sideItem(
				deck.profile.name,
				!this.selectedCustom && this.selected === deck.profile.name,
				quizzes.length,
				dueCount(quizzes),
				() => this.selectProfile(deck.profile.name),
				(ev) => this.profileMenu(deck, ev)
			);
		}

		// saved custom views
		const views = this.ctx.views();
		side.createDiv({ cls: "hl-lex-side-label", text: "我的视图" });
		if (!views.length)
			side.createDiv({
				cls: "hl-qd-side-empty",
				text: "叠加筛选后点「保存为视图」",
			});
		else {
			for (const view of views) {
				const quizzes = this.quizzesForView(view);
				sideItem(
					view.name,
					this.selectedCustom && this.selected === view.name,
					quizzes.length,
					dueCount(quizzes),
					() => this.selectCustom(view),
					(ev) => this.customMenu(view, ev)
				);
			}
		}

		// kind facet (counts within the current base pool)
		const base = this.quizzesForProfile(this.draft.profile);
		side.createDiv({ cls: "hl-lex-side-label", text: "题型" });
		for (const kind of ["year", "cloze", "qa", "map"] as QuizKind[]) {
			const count = base.filter((q) => q.kind === kind).length;
			if (!count) continue;
			const on = this.draft.kinds.includes(kind);
			const item = side.createDiv({
				cls: `hl-lex-side-item${on ? " is-on" : ""}`,
			});
			item.createSpan({
				cls: "hl-lex-side-name",
				text: KIND_LABEL[kind],
			});
			item.createSpan({
				cls: "hl-lex-side-cnt",
				text: String(count),
			});
			item.addEventListener("click", () => {
				this.draft.kinds = on
					? this.draft.kinds.filter((k) => k !== kind)
					: [...this.draft.kinds, kind];
				this.ctx.rerender();
			});
		}

		// status facet
		side.createDiv({ cls: "hl-lex-side-label", text: "状态" });
		for (const [status, label] of [
			["active", "在学"],
			["mastered", "学过"],
		] as const) {
			const count = base.filter((q) => q.status === status).length;
			const on = this.draft.status === status;
			const item = side.createDiv({
				cls: `hl-lex-side-item${on ? " is-on" : ""}`,
			});
			item.createSpan({ cls: "hl-lex-side-name", text: label });
			item.createSpan({
				cls: "hl-lex-side-cnt",
				text: String(count),
			});
			item.addEventListener("click", () => {
				this.draft.status = on ? "" : status;
				this.ctx.rerender();
			});
		}
	}

	// Create a real timeline profile from here: name, then base filter.
	private createProfile(): void {
		const app = this.ctx.plugin.app;
		new NameModal(app, "新建时间线 profile", "", (name) => {
			void (async () => {
				const profiles = await this.ctx.plugin.store.readProfiles();
				if (profiles.some((p) => p.name === name)) {
					new Notice("已有同名 profile");
					return;
				}
				new NameModal(
					app,
					"筛选条件（如 #ad，留空 = 全部）",
					"",
					(match) => {
						void (async () => {
							await this.ctx.plugin.store.writeProfiles([
								...profiles,
								{
									name,
									match: match.trim(),
									groupBy: "century",
									eraSystem: "",
								},
							]);
							await this.ctx.plugin.refreshTimelines();
							this.selectProfile(name);
							this.ctx.onChanged();
						})();
					}
				).open();
			})();
		}).open();
	}

	private profileMenu(deck: WorkbenchDeck, ev: MouseEvent): void {
		ev.preventDefault();
		const menu = new Menu();
		const quizzes = this.quizzesForProfile(deck.profile.name);
		const now = new Date();
		const schedule = this.schedule();
		const due = quizzes.filter(
			(q) => q.status === "active" && isQuizReady(q, now, schedule)
		);
		menu.addItem((i) =>
			i
				.setTitle(due.length ? `开始背诵 ${due.length}` : "无到期")
				.setIcon("brain")
				.setDisabled(!due.length)
				.onClick(() =>
					this.ctx.startSession(
						deck.profile.name,
						due.map((q) => q.id),
						deck.allIds,
						deck.profile.name
					)
				)
		);
		menu.addItem((i) =>
			i
				.setTitle("打开时间线")
				.setIcon("gantt-chart")
				.onClick(() => void this.ctx.plugin.activateTimeline("tab"))
		);
		menu.addItem((i) =>
			i
				.setTitle("另存为我的视图")
				.setIcon("copy-plus")
				.onClick(() =>
					this.saveAsView({
						...emptyQuizView(),
						profile: deck.profile.name,
					})
				)
		);
		menu.showAtMouseEvent(ev);
	}

	private customMenu(view: QuizView, ev: MouseEvent): void {
		ev.preventDefault();
		const menu = new Menu();
		const quizzes = this.quizzesForView(view);
		const now = new Date();
		const schedule = this.schedule();
		const due = quizzes.filter(
			(q) => q.status === "active" && isQuizReady(q, now, schedule)
		);
		menu.addItem((i) =>
			i
				.setTitle(due.length ? `开始背诵 ${due.length}` : "无到期")
				.setIcon("brain")
				.setDisabled(!due.length)
				.onClick(() =>
					this.ctx.startSession(
						view.name,
						due.map((q) => q.id),
						quizzes.map((q) => q.id),
						view.profile
					)
				)
		);
		menu.addItem((i) =>
			i
				.setTitle("更新为当前筛选")
				.setIcon("save")
				.onClick(() => {
					void this.ctx
						.saveViews(
							this.ctx.views().map((v) =>
								v.name === view.name
									? { ...this.draft, name: view.name }
									: v
							)
						)
						.then(() => {
							this.selectCustom({
								...this.draft,
								name: view.name,
							});
							new Notice(`已更新「${view.name}」`);
						});
				})
		);
		menu.addItem((i) =>
			i
				.setTitle("重命名")
				.setIcon("pencil")
				.onClick(() =>
					new NameModal(
						this.ctx.plugin.app,
						"重命名视图",
						view.name,
						(name) => {
							if (
								name !== view.name &&
								this.ctx
									.views()
									.some((v) => v.name === name)
							) {
								new Notice("已有同名视图");
								return;
							}
							if (
								this.selectedCustom &&
								this.selected === view.name
							)
								this.selected = name;
							void this.ctx.saveViews(
								this.ctx.views().map((v) =>
									v.name === view.name
										? { ...v, name }
										: v
								)
							);
						}
					).open()
				)
		);
		menu.addItem((i) =>
			i
				.setTitle("删除视图")
				.setIcon("trash")
				.onClick(() =>
					new ConfirmModal(
						this.ctx.plugin.app,
						"删除视图",
						`删除「${view.name}」？Quiz 和学习进度都会保留。`,
						"删除",
						() => {
							if (
								this.selectedCustom &&
								this.selected === view.name
							) {
								this.selected = null;
								this.selectedCustom = false;
								this.draft = emptyQuizView();
							}
							void this.ctx.saveViews(
								this.ctx
									.views()
									.filter((v) => v.name !== view.name)
							);
						}
					).open()
				)
		);
		menu.showAtMouseEvent(ev);
	}

	private saveAsView(template: QuizView): void {
		new NameModal(this.ctx.plugin.app, "存为新视图", "", (name) => {
			if (this.ctx.views().some((v) => v.name === name)) {
				new Notice("已有同名视图");
				return;
			}
			void this.ctx
				.saveViews([
					...this.ctx.views(),
					{
					...template,
					kinds: [...template.kinds],
					terms: [...template.terms],
					name,
				},
				])
				.then(() => {
					this.selectCustom({ ...template, name });
					new Notice(`已保存「${name}」`);
				});
		}).open();
	}

	// ── main column ──

	// The controls live in a fixed headbar above the scroller, so they can
	// never cover the first card.
	private renderMain(col: HTMLElement): void {
		const items = this.listed();
		const head = col.createDiv({ cls: "hl-lex-headbar" });
		this.renderToolrow(head, this.filtered().length);
		this.renderChips(head);
		this.renderStrip(head);
		const main = col.createDiv({ cls: "hl-lex-main" });
		this.renderRows(main, items);
	}

	// Floating bottom-right switch to the vocab workbench; it stays put
	// while the list scrolls.
	private renderSwitchFab(shell: HTMLElement): void {
		const fab = shell.createEl("button", { cls: "hl-lex-fab" });
		setIcon(fab, "book-a");
		fab.setAttr("aria-label", "切换到 Vocab");
		fab.addEventListener("click", () =>
			void this.ctx.plugin.openLexicon(false)
		);
	}

	// The current filter spelled out as removable chips, timeline style —
	// whether it came from a saved view, the facets, or the search box.
	private renderChips(main: HTMLElement): void {
		const d = this.draft;
		if (
			!d.profile &&
			!d.kinds.length &&
			!d.status &&
			!d.terms.length
		)
			return;
		const row = main.createDiv({ cls: "hl-qd-chiprow" });
		const icon = row.createSpan({ cls: "hl-filter-icon" });
		setIcon(icon, "filter");
		const chip = (label: string, remove: () => void): void => {
			const el = row.createSpan({ cls: "hl-chip" });
			el.createSpan({ text: label });
			const x = el.createSpan({ cls: "hl-chip-x" });
			setIcon(x, "x");
			x.addEventListener("click", () => {
				remove();
				this.ctx.rerender();
			});
		};
		if (d.profile)
			chip(d.profile, () => {
				d.profile = "";
				if (!this.selectedCustom) {
					this.selected = null;
					this.selectedCustom = false;
				}
			});
		for (const kind of d.kinds)
			chip(KIND_LABEL[kind], () => {
				d.kinds = d.kinds.filter((k) => k !== kind);
			});
		if (d.status)
			chip(d.status === "active" ? "在学" : "学过", () => {
				d.status = "";
			});
		for (const term of d.terms)
			chip(`“${term}”`, () => {
				d.terms = d.terms.filter((t) => t !== term);
			});
	}

	private renderToolrow(main: HTMLElement, count: number): void {
		const row = main.createDiv({ cls: "hl-lex-toolrow" });
		row.createEl("h1", { text: this.selected ?? "全部 Quiz" });
		if (this.dirty()) {
			const bound = this.boundView();
			const reset = row.createSpan({ cls: "hl-lex-dirty" });
			setIcon(reset, "rotate-ccw");
			reset.setAttr(
				"aria-label",
				bound
					? "筛选已修改 · 点击恢复视图原筛选"
					: "有附加筛选 · 点击清空"
			);
			reset.addEventListener("click", () => {
				this.search = "";
				if (bound) this.selectCustom(bound);
				else if (this.selected)
					this.selectProfile(this.selected);
				else this.selectPool();
			});
		}
		row.createSpan({ cls: "hl-lex-total", text: `${count} 道` });
		row.createSpan({ cls: "hl-lex-tsep", text: "·" });

		const group = row.createSpan({ cls: "hl-lex-tctl" });
		group.createSpan({
			cls: "hl-lex-strong",
			text: GROUP_NAMES[this.draft.group],
		});
		group.addEventListener("click", (ev) => {
			const menu = new Menu();
			for (const [v, t] of Object.entries(GROUP_NAMES))
				menu.addItem((i) =>
					i
						.setTitle(t)
						.setChecked(this.draft.group === v)
						.onClick(() => {
							this.draft.group = v as QuizViewGroup;
							this.scrollResetNext = true;
							this.ctx.rerender();
						})
				);
			menu.showAtMouseEvent(ev);
		});

		const sort = row.createSpan({ cls: "hl-lex-tctl" });
		sort.createSpan({
			cls: "hl-lex-strong",
			text: `${SORT_NAMES[this.draft.sort]} ${
				this.sortDesc ? "↓" : "↑"
			}`,
		});
		sort.addEventListener("click", (ev) => {
			const menu = new Menu();
			for (const [v, t] of Object.entries(SORT_NAMES))
				menu.addItem((i) =>
					i
						.setTitle(
							this.draft.sort === v
								? `${t} ${this.sortDesc ? "↓" : "↑"}`
								: t
						)
						.setChecked(this.draft.sort === v)
						.onClick(() => {
							// Picking the current sort again flips its
							// direction.
							if (this.draft.sort === v)
								this.sortDesc = !this.sortDesc;
							else {
								this.draft.sort = v as QuizViewSort;
								this.sortDesc = false;
							}
							this.scrollResetNext = true;
							this.ctx.rerender();
						})
				);
			menu.showAtMouseEvent(ev);
		});

		row.createDiv({ cls: "hl-lex-spacer" });

		const save = row.createEl("button", {
			cls: "hl-lex-save",
			text: "保存为视图",
		});
		save.addEventListener("click", () => this.saveAsView(this.draft));
		const wall = row.createEl("button", {
			cls: "hl-lex-save hl-qd-wallbtn",
		});
		setIcon(wall.createSpan(), "layout-grid");
		wall.createSpan({ text: "deck 总览" });
		wall.addEventListener("click", () => {
			this.overview = true;
			this.ctx.rerender();
		});
	}

	// ── study strip ──

	private renderStrip(main: HTMLElement): void {
		const strip = main.createDiv({ cls: "hl-lex-strip" });
		const fill = (el: HTMLElement): void => this.fillStrip(el);
		fill(strip);
		this.ctx.registerDynamic(
			strip,
			() => {
				const pool = this.filtered();
				const now = new Date();
				const schedule = this.schedule();
				return pool
					.map((q) => this.section(q, now, schedule))
					.join("|");
			},
			fill
		);
	}

	private fillStrip(strip: HTMLElement): void {
		const quizzes = this.filtered();
		const stats = quizDeckStats(quizzes, new Date(), this.schedule());
		const icon = strip.createSpan({ cls: "hl-lex-strip-icon" });
		setIcon(icon, "brain");
		const seg = (
			key: Exclude<StudyFilter, null>,
			label: string,
			num: number,
			cls = ""
		): void => {
			const el = strip.createSpan({
				cls: `hl-lex-strip-seg${
					this.studyFilter === key ? " is-on" : ""
				}${cls}`,
			});
			el.createSpan({ cls: "hl-lex-strip-num", text: String(num) });
			el.createSpan({ text: label });
			el.addEventListener("click", () => {
				this.studyFilter = this.studyFilter === key ? null : key;
				this.scrollResetNext = true;
				this.ctx.rerender();
			});
		};
		const now = new Date();
		const schedule = this.schedule();
		const counts: Record<Exclude<StudyFilter, null>, number> = {
			due: 0,
			fresh: 0,
			waiting: 0,
			active: 0,
			mastered: 0,
		};
		for (const q of quizzes) counts[this.section(q, now, schedule)]++;
		seg("due", "待复习", counts.due, " is-due");
		seg("fresh", "待学习", counts.fresh);
		seg("waiting", "稍后", counts.waiting, " is-wait");
		seg("active", "在学", counts.active);
		seg("mastered", "学过", counts.mastered);
		strip.createDiv({ cls: "hl-lex-spacer" });
		const label = this.selected ?? "全部 Quiz";
		const scopeIds = quizzes.map((q) => q.id);
		// Reviews first, then short-loop retries, fresh cards last — the
		// session works through what is actually due before anything new.
		const ready = quizzes.filter(
			(q) => q.status === "active" && isQuizReady(q, now, schedule)
		);
		const rank = (q: QuizEntry): number => {
			const s = this.section(q, now, schedule);
			return s === "due" ? 0 : s === "waiting" ? 1 : 2;
		};
		const dueIds = ready
			.map((q, i) => ({ q, i }))
			.sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i)
			.map((x) => x.q.id);
		const activeIds = quizzes
			.filter((q) => q.status === "active")
			.map((q) => q.id);
		if (dueIds.length) {
			const go = strip.createEl("button", {
				cls: "mod-cta",
				text: "开始背诵",
			});
			go.addEventListener("click", () =>
				this.ctx.startSession(
					label,
					dueIds,
					scopeIds,
					this.draft.profile
				)
			);
		} else if (activeIds.length) {
			const go = strip.createEl("button", {
				cls: "hl-lex-ghost",
				text: "提前复习",
			});
			go.addEventListener("click", () =>
				this.ctx.startSession(
					label,
					activeIds,
					scopeIds,
					this.draft.profile
				)
			);
		} else {
			strip.createSpan({
				cls: "hl-lex-strip-done",
				text: quizzes.length ? "都完成了 ✓" : "没有 Quiz",
			});
		}
	}

	// ── quiz rows ──

	private renderRows(main: HTMLElement, items: QuizEntry[]): void {
		if (!items.length) {
			main.createDiv({
				cls: "hl-lex-empty",
				text: "没有符合筛选的 Quiz — 去 Timeline 的事件上创建。",
			});
			return;
		}
		const host = main.createDiv();
		const fill = (el: HTMLElement): void => {
			for (const g of this.grouped(items)) {
				if (g.label) {
					const head = el.createDiv({ cls: "hl-lex-ghead" });
					if (g.render) g.render(head);
					else head.setText(`${g.label} · ${g.items.length}`);
				}
				for (const quiz of g.items) this.renderRow(el, quiz);
			}
		};
		fill(host);
		this.ctx.registerDynamic(
			host,
			() =>
				this.grouped(items)
					.map(
						(g) =>
							g.label +
							g.items
								.map(
									(q) =>
										q.id + this.rowStateLabel(q).text
								)
								.join(",")
					)
					.join("|"),
			fill
		);
	}

	private eventOf(quiz: QuizEntry): EventEntry | undefined {
		return this.ctx.events().get(quiz.sourceEvId);
	}

	private yearKey(quiz: QuizEntry): number {
		const tag = this.eventOf(quiz)?.tag;
		const decoded = tag ? parseYearTag(tag) : null;
		return decoded ? decoded.sortKey : Number.MAX_SAFE_INTEGER;
	}

	private sorted(items: QuizEntry[]): QuizEntry[] {
		const now = new Date();
		const schedule = this.schedule();
		const sort = this.draft.sort;
		const dir = this.sortDesc ? -1 : 1;
		return [...items].sort((a, b) => {
			if (sort === "year")
				return dir * (this.yearKey(a) - this.yearKey(b));
			if (sort === "created")
				return (
					dir * (a.created ?? "").localeCompare(b.created ?? "")
				);
			// due first, then by next review time, then newest first
			const rank = (q: QuizEntry): number =>
				q.status === "mastered"
					? 3
					: isQuizReady(q, now, schedule)
					? 0
					: isQuizWaiting(q, now, schedule)
					? 1
					: 2;
			const d = rank(a) - rank(b);
			if (d) return dir * d;
			const ra = a.nextReview ?? "";
			const rb = b.nextReview ?? "";
			if (ra !== rb) return dir * ra.localeCompare(rb);
			return dir * (b.created ?? "").localeCompare(a.created ?? "");
		});
	}

	private grouped(items: QuizEntry[]): {
		label: string;
		items: QuizEntry[];
		render?: (el: HTMLElement) => void;
	}[] {
		const sorted = this.sorted(items);
		const group = this.draft.group;
		if (group === "none") return [{ label: "", items: sorted }];
		if (group === "state") {
			const now = new Date();
			const schedule = this.schedule();
			const order: [Exclude<StudyFilter, null>, string][] = [
				["due", "待复习"],
				["fresh", "待学习"],
				["waiting", "稍后"],
				["active", "在学"],
				["mastered", "学过"],
			];
			const buckets = order.map(([key, label]) => ({
				key,
				label,
				items: [] as QuizEntry[],
			}));
			for (const q of sorted) {
				const s = this.section(q, now, schedule);
				buckets.find((b) => b.key === s)?.items.push(q);
			}
			return buckets.filter((b) => b.items.length);
		}
		if (group === "kind") {
			const order: QuizKind[] = ["year", "cloze", "qa", "map"];
			return order
				.map((kind) => ({
					label: KIND_LABEL[kind],
					items: sorted.filter((q) => q.kind === kind),
				}))
				.filter((b) => b.items.length);
		}
		// by event (map quizzes group under their map)
		const buckets = new Map<
			string,
			{
				label: string;
				items: QuizEntry[];
				render?: (el: HTMLElement) => void;
				order: number;
			}
		>();
		for (const q of sorted) {
			let key: string;
			let label: string;
			let render: ((el: HTMLElement) => void) | undefined;
			if (q.kind === "map" && q.sourceMapId) {
				const map = this.ctx.maps().get(q.sourceMapId);
				key = `map:${q.sourceMapId}`;
				label = `🗺 ${
					map
						? mapDisplayTitle(map) || "未命名地图"
						: "来源地图已不存在"
				}`;
			} else {
				const event = this.eventOf(q);
				key = q.sourceEvId;
				const decoded = event?.tag ? parseYearTag(event.tag) : null;
				const year = decoded
					? describeYear(decoded)
					: event?.tag ?? "";
				label = year || "来源事件已不存在";
				if (event) {
					const summary = event.summary;
					const colors = this.ctx.colors();
					const plugin = this.ctx.plugin;
					render = (el) => {
						el.createSpan({
							cls: "hl-qd-ghead-year",
							text: year || "—",
						});
						const sum = el.createSpan({
							cls: "hl-qd-ghead-summary",
						});
						renderQuizText(plugin, summary, sum, colors);
					};
				}
			}
			const bucket = buckets.get(key) ?? {
				label,
				items: [],
				render,
				order: this.yearKey(q),
			};
			bucket.items.push(q);
			buckets.set(key, bucket);
		}
		return [...buckets.values()].sort((a, b) => a.order - b.order);
	}

	private rowStateLabel(quiz: QuizEntry): {
		text: string;
		cls: string;
	} {
		const now = new Date();
		const schedule = this.schedule();
		// The row echoes the card's section, so the state stays readable
		// under any grouping. Fresh cards carry no text — untouched dots
		// say it all.
		switch (this.section(quiz, now, schedule)) {
			case "mastered":
				return { text: "学过", cls: "" };
			case "waiting": {
				if (isQuizWaiting(quiz, now, schedule)) {
					const wait = nextReviewLabel(quiz, now, schedule);
					return {
						text: wait ? `⏰ ${wait}` : "⏰ 稍后",
						cls: " is-wait",
					};
				}
				// Wait elapsed unanswered: the alarm turns red and counts
				// how long it's been ringing.
				const due = Date.parse(quiz.nextReview ?? "");
				const mins = Number.isNaN(due)
					? 0
					: Math.max(
							1,
							Math.round((now.getTime() - due) / 60_000)
					  );
				const span =
					mins >= 60
						? `${Math.round(mins / 60)} 小时`
						: `${mins} 分钟`;
				return { text: `⏰ 超时 ${span}`, cls: " is-overdue" };
			}
			case "due":
				return { text: "待复习", cls: " is-overdue" };
			case "active":
				return {
					text: nextReviewLabel(quiz, now, schedule),
					cls: "",
				};
			default:
				return { text: "待学习", cls: " is-fresh" };
		}
	}

	private renderRow(host: HTMLElement, quiz: QuizEntry): void {
		const row = host.createDiv({ cls: "hl-qd-row" });
		row.createSpan({
			cls: `hl-qd-kind hl-qd-kind-${quiz.kind}`,
			text: KIND_LABEL[quiz.kind],
		});
		const mainCol = row.createDiv({ cls: "hl-qd-main" });
		const event = this.eventOf(quiz);
		const colors = this.ctx.colors();
		const text = mainCol.createDiv({ cls: "hl-qd-text" });
		if (quiz.kind === "map") {
			const ic = text.createSpan({ cls: "hl-qd-mapic" });
			this.renderMapIcon(ic, quiz);
			const custom = quiz.question.trim().startsWith("🗺")
				? ""
				: quiz.question.trim();
			renderQuizText(
				this.ctx.plugin,
				custom || "这处遮罩对应地图上的哪里？",
				text,
				colors
			);
		} else this.renderQuestion(text, quiz, event, colors);

		const meta = mainCol.createDiv({ cls: "hl-qd-meta" });
		const decoded = event?.tag ? parseYearTag(event.tag) : null;
		if (decoded || event?.tag) {
			// The year is the answer of an unmastered YEAR quiz — never
			// show it. Other rows follow the hover-to-peek setting.
			const hideYear =
				quiz.kind === "year" && quiz.status !== "mastered";
			const peek =
				!hideYear &&
				this.ctx.plugin.settings.quizHoverHideYears;
			const year = meta.createSpan({
				cls: `hl-qd-meta-year${peek ? " hl-qd-year-peek" : ""}`,
				text: hideYear
					? "年份？"
					: decoded
					? describeYear(decoded)
					: event?.tag ?? "",
			});
			if (peek) year.setAttr("aria-label", "悬停显示年份");
		}
		if (quiz.kind === "map" && quiz.sourceMapId) {
			const map = this.ctx.maps().get(quiz.sourceMapId);
			if (map) {
				const idx = map.occlusions.findIndex(
					(o) => o.id === quiz.occlusionId
				);
				const parts = [
					mapDisplayTitle(map),
					idx >= 0 ? `遮罩 ${idx + 1}` : "",
				].filter(Boolean);
				if (parts.length)
					meta.createSpan({ text: parts.join(" · ") });
			}
		}
		const steps = this.schedule().masterySteps;
		const dots = meta.createSpan({ cls: "hl-qd-dots" });
		dots.setAttr("aria-label", `掌握 ${quiz.progress}/${steps}`);
		for (let i = 0; i < steps; i++)
			dots.createSpan({
				cls: `hl-qd-dot${i < quiz.progress ? " is-on" : ""}`,
			});
		if (quiz.cycles.length > 1)
			meta.createSpan({ text: `第 ${quiz.cycles.length} 轮` });
		const state = this.rowStateLabel(quiz);
		if (state.text)
			meta.createSpan({
				cls: `hl-qd-meta-state${state.cls}`,
				text: state.text,
			});

		// hover actions: study (brain) / edit / everything else under ⋯
		const acts = row.createDiv({ cls: "hl-lex-eacts hl-qd-acts" });
		const act = (
			icon: string,
			label: string,
			run: (ev: MouseEvent) => void
		): void => {
			const el = acts.createSpan({ cls: "hl-lex-eact" });
			setIcon(el, icon);
			el.setAttr("aria-label", label);
			el.addEventListener("click", (ev) => {
				ev.stopPropagation();
				run(ev);
			});
		};
		act("pencil", "编辑", () => this.editRow(quiz, event));
		if (quiz.status === "mastered")
			act("rotate-ccw", "重新学习", () => this.reviveRow(quiz));
		else act("brain", "练习", () => this.practice(quiz));
		act("more-horizontal", "更多操作", (ev) =>
			this.rowMenu(quiz, event, ev)
		);
		row.addEventListener("contextmenu", (ev) =>
			this.rowMenu(quiz, event, ev)
		);
	}

	// A tiny thumbnail of the source map stands in for the generic map
	// icon; missing images fall back to it.
	private renderMapIcon(host: HTMLElement, quiz: QuizEntry): void {
		const map = quiz.sourceMapId
			? this.ctx.maps().get(quiz.sourceMapId)
			: undefined;
		const app = this.ctx.plugin.app;
		const file = map
			? app.metadataCache.getFirstLinkpathDest(map.image, "")
			: null;
		if (!file) {
			setIcon(host, "map");
			return;
		}
		const img = host.createEl("img", { cls: "hl-qd-mapthumb" });
		img.src = app.vault.getResourcePath(file);
		img.addEventListener("error", () => {
			host.empty();
			setIcon(host, "map");
		});
	}

	// The question with its blank masked in place, exactly as in the design
	// sample: only year/cloze questions carry a `____` blank; the answer sits
	// blurred at that spot and a click reveals it. Other kinds render the
	// question as-is, nothing appended.
	private renderQuestion(
		host: HTMLElement,
		quiz: QuizEntry,
		event: EventEntry | undefined,
		colors: DbColors
	): void {
		const plugin = this.ctx.plugin;
		const question = quizQuestion(quiz, event);
		const answer =
			quiz.kind === "year" || quiz.kind === "cloze"
				? quizAnswer(quiz, event).trim()
				: "";
		const idx = question.indexOf("____");
		if (!answer || idx < 0) {
			renderQuizText(plugin, question, host, colors);
			return;
		}
		const before = question.slice(0, idx);
		const after = question.slice(idx + 4).replace(/____/g, "…");
		if (before) renderQuizText(plugin, before, host, colors);
		const revealed = this.revealed.has(quiz.id);
		const blank = host.createSpan({
			cls: `hl-qd-blank${revealed ? " is-open" : ""}`,
		});
		renderQuizText(plugin, answer, blank, colors);
		blank.setAttr(
			"aria-label",
			revealed ? "点击遮住答案" : "点击显示答案"
		);
		blank.addEventListener("click", (ev) => {
			ev.stopPropagation();
			const open = !this.revealed.has(quiz.id);
			if (open) this.revealed.add(quiz.id);
			else this.revealed.delete(quiz.id);
			blank.toggleClass("is-open", open);
			blank.setAttr(
				"aria-label",
				open ? "点击遮住答案" : "点击显示答案"
			);
		});
		if (after) renderQuizText(plugin, after, host, colors);
	}

	private practice(quiz: QuizEntry): void {
		new QuizPracticeModal(
			this.ctx.plugin.app,
			this.ctx.plugin,
			quiz.id,
			() => this.ctx.onChanged()
		).open();
	}

	private editRow(quiz: QuizEntry, event: EventEntry | undefined): void {
		if (quiz.kind === "map" && quiz.sourceMapId) {
			void this.ctx.plugin.openMapViewer(
				quiz.sourceMapId,
				() => this.ctx.onChanged(),
				quiz.occlusionId
			);
			return;
		}
		this.ctx.plugin.openQuizManager(
			quiz.sourceEvId,
			event?.tag ?? "",
			"",
			undefined,
			quiz.id
		);
	}

	private reviveRow(quiz: QuizEntry): void {
		new ConfirmModal(
			this.ctx.plugin.app,
			"重新学习",
			"把这道学过的 Quiz 重新加入学习？掌握进度将从 0 开始新一轮。",
			"重新学习",
			() =>
				void (async () => {
					await this.ctx.plugin.store.upsertQuiz(
						reviveQuiz(quiz)
					);
					await this.ctx.plugin.refreshTimelines();
					this.ctx.onChanged();
				})()
		).open();
	}

	// The full per-quiz action menu — everything the backstage and deck
	// pages offered lives here.
	private rowMenu(
		quiz: QuizEntry,
		event: EventEntry | undefined,
		ev: MouseEvent
	): void {
		ev.preventDefault();
		const plugin = this.ctx.plugin;
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("练习")
				.setIcon("brain")
				.onClick(() => this.practice(quiz))
		);
		menu.addItem((i) =>
			i
				.setTitle(
					quiz.kind === "map" ? "编辑地图遮罩" : "编辑 Quiz"
				)
				.setIcon("pencil")
				.onClick(() => this.editRow(quiz, event))
		);
		if (event?.tag) {
			const tag = event.tag;
			menu.addItem((i) =>
				i
					.setTitle("在时间线上显示")
					.setIcon("gantt-chart")
					.onClick(() =>
						void plugin.revealOnTimelineForProfile(
							this.draft.profile,
							quiz.sourceEvId,
							tag
						)
					)
			);
			menu.addItem((i) =>
				i
					.setTitle("编辑事件总结")
					.setIcon("hourglass")
					.onClick(() =>
						plugin.openSummary(quiz.sourceEvId, tag, () =>
							this.ctx.onChanged()
						)
					)
			);
		}
		if (quiz.kind === "map" && quiz.sourceMapId) {
			const mapId = quiz.sourceMapId;
			menu.addItem((i) =>
				i
					.setTitle("查看地图")
					.setIcon("map")
					.onClick(() =>
						void plugin.openMapViewer(mapId, () =>
							this.ctx.onChanged()
						)
					)
			);
			const map = this.ctx.maps().get(mapId);
			if (map)
				menu.addItem((i) =>
					i
						.setTitle("编辑地图")
						.setIcon("image")
						.onClick(() =>
							new MapModal(
								plugin.app,
								plugin,
								map,
								false,
								() => this.ctx.onChanged()
							).open()
						)
				);
		}
		if (quiz.status === "mastered")
			menu.addItem((i) =>
				i
					.setTitle("重新学习")
					.setIcon("rotate-ccw")
					.onClick(() => this.reviveRow(quiz))
			);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("删除 Quiz")
				.setIcon("trash-2")
				.onClick(() =>
					new ConfirmModal(
						plugin.app,
						"删除 Quiz",
						"删除这个 Quiz 及其全部练习记录？",
						"删除",
						() =>
							void (async () => {
								await plugin.store.removeQuiz(quiz.id);
								await plugin.refreshTimelines();
								this.ctx.onChanged();
							})()
					).open()
				)
		);
		menu.showAtMouseEvent(ev);
	}

	// ── deck overview ──

	private renderOverview(shell: HTMLElement): void {
		const wall = shell.createDiv({ cls: "hl-lex-main hl-qd-wall" });
		const top = wall.createDiv({ cls: "hl-lex-toolrow" });
		const back = top.createSpan({ cls: "hl-qd-backlink" });
		setIcon(back.createSpan(), "arrow-left");
		back.createSpan({ text: "返回列表" });
		back.addEventListener("click", () => {
			this.overview = false;
			this.ctx.rerender();
		});
		top.createEl("h1", { text: "deck 总览" });
		const decks = this.ctx.decks();
		const views = this.ctx.views();
		top.createSpan({
			cls: "hl-lex-total",
			text: `${decks.length} 个内置 · ${views.length} 个自定义`,
		});
		const grid = wall.createDiv({ cls: "hl-qd-deckgrid" });
		for (const deck of decks)
			this.renderDeckCard(
				grid,
				deck.profile.name,
				"时间线 profile",
				this.quizzesForProfile(deck.profile.name),
				deck.allIds,
				deck.profile.name,
				() => this.selectProfile(deck.profile.name),
				(ev) => this.profileMenu(deck, ev)
			);
		for (const view of views) {
			const quizzes = this.quizzesForView(view);
			const bits: string[] = ["我的视图"];
			if (view.profile) bits.push(view.profile);
			if (view.kinds.length)
				bits.push(
					view.kinds.map((k) => KIND_LABEL[k]).join("/")
				);
			if (view.status)
				bits.push(view.status === "active" ? "在学" : "学过");
			this.renderDeckCard(
				grid,
				view.name,
				bits.join(" · "),
				quizzes,
				quizzes.map((q) => q.id),
				view.profile,
				() => this.selectCustom(view),
				(ev) => this.customMenu(view, ev)
			);
		}
	}

	private renderDeckCard(
		grid: HTMLElement,
		name: string,
		source: string,
		quizzes: QuizEntry[],
		scopeIds: string[],
		profileName: string,
		onOpen: () => void,
		onCtx: (ev: MouseEvent) => void
	): void {
		const card = grid.createDiv({ cls: "hl-qd-deck" });
		card.addEventListener("click", onOpen);
		card.addEventListener("contextmenu", onCtx);
		const fill = (el: HTMLElement): void => {
			const stats = quizDeckStats(
				quizzes,
				new Date(),
				this.schedule()
			);
			this.fillDeckCard(
				el,
				name,
				source,
				stats,
				quizzes,
				scopeIds,
				profileName
			);
		};
		fill(card);
		this.ctx.registerDynamic(
			card,
			() => {
				const s = quizDeckStats(
					quizzes,
					new Date(),
					this.schedule()
				);
				return [s.due, s.waiting, s.active, s.mastered].join("|");
			},
			fill
		);
	}

	private fillDeckCard(
		card: HTMLElement,
		name: string,
		source: string,
		stats: DeckStats,
		quizzes: QuizEntry[],
		scopeIds: string[],
		profileName: string
	): void {
		const head = card.createDiv({ cls: "hl-deck-head" });
		head.createDiv({ cls: "hl-qd-deck-name", text: name });
		if (stats.due > 0)
			head.createSpan({
				cls: "hl-lex-side-due",
				text: String(stats.due),
			});
		card.createDiv({ cls: "hl-qd-deck-src", text: source });
		renderMasteryBar(card, stats);
		const line = card.createDiv({ cls: "hl-qd-deck-stats" });
		const stat = (num: number, label: string, cls = ""): void => {
			if (!num) return;
			const el = line.createSpan({ cls: `hl-qd-deck-stat${cls}` });
			el.createSpan({ cls: "hl-lex-strip-num", text: String(num) });
			el.createSpan({ text: label });
		};
		stat(stats.due, "待复习", " is-due");
		stat(stats.waiting, "稍后", " is-wait");
		stat(stats.active, "在学");
		stat(stats.mastered, "学过");
		if (!quizzes.length)
			line.createSpan({ text: "还没有 Quiz" });
		const foot = card.createDiv({ cls: "hl-qd-deck-foot" });
		const now = new Date();
		const schedule = this.schedule();
		const dueIds = quizzes
			.filter(
				(q) =>
					q.status === "active" && isQuizReady(q, now, schedule)
			)
			.map((q) => q.id);
		const go = foot.createEl("button", {
			cls: "hl-qd-deck-start",
			text: dueIds.length ? `开始背诵 ${dueIds.length}` : "无到期",
		});
		if (dueIds.length)
			go.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.ctx.startSession(name, dueIds, scopeIds, profileName);
			});
		else go.disabled = true;
	}
}
