// The lexicon workbench: a dictionary-style library of entities, separate
// from the event-quiz recitation hub. Three-layer layout: a left rail
// (saved views / tag tree / types / search), a quiet text toolrow
// (direction · sort · grouping), and dictionary-entry rows whose target-
// language spellings are masked in place with the plugin's existing cloze
// blur. A view can carry a study deck with persistent per-«entity ×
// language» progress; the study strip above the list shows due / waiting /
// active / mastered and launches the per-language-rated session.

import {
	ItemView,
	Menu,
	Notice,
	TFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EntityEntry, displayName, orderLangs } from "./db-format";
import {
	DbColors,
	langDisplayName,
	loadDbColors,
	playEntityAudio,
} from "./quiz-render";
import { EntityModal } from "./entity-modal";
import { NameModal, ConfirmModal } from "./name-modal";
import { QuizSchedule } from "./quiz";
import { quizSchedule } from "./quiz-display";
import { quizDeckStats, DeckStats } from "./deck-stats";
import { jumpToLocation } from "./jump";
import {
	ContextHint,
	contextHintsForMany,
	renderContextMarkdown,
} from "./recite-context";
import {
	GROUPS,
	ReciteView,
	SORTS,
	ViewGroup,
	ViewSort,
	emptyView,
	entityMatchesView,
	hasLang,
	studyMembers,
} from "./recite-views";
import {
	ReciteProgress,
	isProgressDue,
	isProgressWaiting,
	progressKey,
	toQuizShape,
} from "./recite-progress";
import { StudyPlayerPage, StudyItem } from "./recite-study-player";

export const LEXICON_VIEW_TYPE = "history-logging-lexicon";

type StudyFilter = null | "due" | "waiting" | "active" | "mastered";

function normTag(t: string): string {
	return t.replace(/^#+/, "").trim();
}

// Compact «ja → 中 / EN» direction tag for the sidebar and menus.
function dirLabel(view: { from: string; to: string[] }): string {
	if (!view.from || !view.to.length) return "";
	const to = orderLangs(view.to.filter((l) => l !== view.from));
	if (!to.length) return "";
	return `${langDisplayName(view.from)} → ${to
		.map(langDisplayName)
		.join(" / ")}`;
}

function entityStamp(e: EntityEntry): string {
	return e.created ?? e.updated ?? "";
}

function addedLabel(stamp: string): string {
	const day = stamp.slice(0, 10);
	return day ? `加入于 ${day}` : "";
}

// Relative buckets for the date grouping headers (the meta line keeps the
// absolute date): 今天 / 昨天 / 过去 7 天 / 过去 30 天, then by month. The rank
// sorts ascending — newest bucket first, newer months first.
function dateBucket(stamp: string): { rank: string; label: string } {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
	if (!m) return { rank: "9", label: "未记日期" };
	const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const days = Math.round(
		(today.getTime() - at.getTime()) / (24 * 3600 * 1000)
	);
	if (days <= 0) return { rank: "0", label: "今天" };
	if (days === 1) return { rank: "1", label: "昨天" };
	if (days < 7) return { rank: "2", label: "过去 7 天" };
	if (days < 30) return { rank: "3", label: "过去 30 天" };
	const ym = at.getFullYear() * 100 + (at.getMonth() + 1);
	return {
		rank: `4|${String(999999 - ym).padStart(6, "0")}`,
		label: `${at.getFullYear()} 年 ${at.getMonth() + 1} 月`,
	};
}

// Direction counts plus the merged per-word view: a word is due/waiting/
// active when any of its directions is, mastered only when all are.
export interface LexStats extends DeckStats {
	words: {
		due: number;
		waiting: number;
		active: number;
		mastered: number;
	};
}

// Study stats for a view over member × language keys; directions never
// studied count as fresh active cards (due now).
export function lexStudyStats(
	view: ReciteView,
	entities: Iterable<EntityEntry>,
	progress: Map<string, ReciteProgress>,
	schedule: QuizSchedule,
	now = new Date()
): LexStats {
	const members = studyMembers(entities, view);
	const shapes = [];
	let fresh = 0;
	const words = { due: 0, waiting: 0, active: 0, mastered: 0 };
	for (const e of members) {
		let due = false;
		let waiting = false;
		let active = false;
		let dirs = 0;
		for (const lang of view.to) {
			if (lang === view.from || !hasLang(e, lang)) continue;
			dirs++;
			const rec = progress.get(progressKey(e.id, view.from, lang));
			if (rec) shapes.push(toQuizShape(rec));
			else fresh++;
			if (rec?.status === "mastered") continue;
			active = true;
			if (isProgressWaiting(rec, now, schedule)) waiting = true;
			else if (isProgressDue(rec, now, schedule)) due = true;
		}
		if (!dirs) continue;
		if (due) words.due++;
		if (waiting) words.waiting++;
		if (active) words.active++;
		else words.mastered++;
	}
	const stats = quizDeckStats(shapes, now, schedule);
	stats.active += fresh;
	stats.due += fresh;
	if (stats.progressDist.length) stats.progressDist[0] += fresh;
	return { ...stats, words };
}

export class LexiconView extends ItemView {
	private entities = new Map<string, EntityEntry>();
	private views: ReciteView[] = [];
	private progress = new Map<string, ReciteProgress>();
	// null selection = the whole library.
	private selected: string | null = null;
	private draft: ReciteView = emptyView();
	private search = "";
	private studyFilter: StudyFilter = null;
	private revealed = new Set<string>(); // `${id}:${lang}`
	private ctxOpen = new Set<string>(); // entity ids with expanded context
	private ctxIndex = new Map<string, number>();
	private contexts: Map<string, ContextHint[]> | null = null;
	private colors: DbColors = new Map();
	private selectMode = false;
	private selectedIds = new Set<string>();
	// Name of the view that last received members, the fallback «+» target
	// when browsing outside any view.
	private lastTarget: string | null = null;
	private ctxLoading = false;
	private player: StudyPlayerPage | null = null;
	private playing = false;
	private loading = false;
	private dataSig = "";
	private needsRender = true;
	private queueReload = debounce(() => void this.reload(), 1500, true);

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return LEXICON_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "词汇";
	}

	getIcon(): string {
		return "book-a";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (f instanceof TFile && f.extension === "md")
					this.queueReload();
			})
		);
		this.registerEvent(this.app.vault.on("delete", () => this.queueReload()));
		this.registerEvent(this.app.vault.on("rename", () => this.queueReload()));
		await this.reload();
	}

	onunload(): void {
		this.player?.unmount();
	}

	async reload(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		try {
			const [views, progress, entities, colors] = await Promise.all([
				this.plugin.store.readReciteViews(),
				this.plugin.store.readReciteProgress(),
				this.plugin.store.readEntities(),
				loadDbColors(this.plugin),
			]);
			this.views = views;
			this.progress = progress;
			this.entities = entities;
			this.colors = colors;
		} finally {
			this.loading = false;
		}
		const sig = JSON.stringify({
			v: this.views,
			p: [...this.progress.entries()],
			e: [...this.entities.entries()],
		});
		// The whole-library draft starts blank; restore the persisted
		// parameters (or the default direction) so first open already
		// shows the language rows.
		if (!this.selected && !this.draft.from && !this.draft.to.length)
			this.applyLibraryParams();
		if (sig !== this.dataSig) {
			this.dataSig = sig;
			this.contexts = null;
			this.needsRender = true;
		}
		if (this.needsRender && !this.playing) {
			this.needsRender = false;
			this.render();
		}
	}

	private schedule(): QuizSchedule {
		return quizSchedule(this.plugin.settings);
	}

	// ── whole-library desk ──

	private applyLibraryParams(): void {
		const saved = this.plugin.settings.lexLibrary;
		if (saved) {
			this.draft.from = saved.from;
			this.draft.to = [...saved.to];
			this.draft.requireFrom = saved.requireFrom;
			if (SORTS.has(saved.sort as ViewSort))
				this.draft.sort = saved.sort as ViewSort;
			if (GROUPS.has(saved.group as ViewGroup))
				this.draft.group = saved.group as ViewGroup;
			return;
		}
		this.draft.from = this.plugin.settings.entityLangs[0] ?? "";
		this.draft.to = this.plugin.settings.entityLangs.slice(1);
	}

	// The whole-library desk has no saved view to write back to; its display
	// parameters persist into settings on every change instead.
	private persistLibraryParams(): void {
		if (this.selected || !this.draft.from) return;
		const cur = {
			from: this.draft.from,
			to: [...this.draft.to],
			requireFrom: this.draft.requireFrom,
			sort: this.draft.sort,
			group: this.draft.group,
		};
		const prev = this.plugin.settings.lexLibrary;
		if (
			prev &&
			prev.from === cur.from &&
			prev.requireFrom === cur.requireFrom &&
			prev.sort === cur.sort &&
			prev.group === cur.group &&
			prev.to.join(",") === cur.to.join(",")
		)
			return;
		this.plugin.settings.lexLibrary = cur;
		void this.plugin.saveSettings();
	}

	// Entities enrolled in any study view. The whole-library deck is the
	// union of all decks — marking a word for memorisation always means
	// adding it to a concrete view, never to the library itself.
	private enrolledIds(): Set<string> {
		const ids = new Set<string>();
		for (const v of this.views) {
			if (!v.study) continue;
			for (const e of studyMembers(this.entities.values(), v))
				ids.add(e.id);
		}
		return ids;
	}

	// Synthetic deck over the whole library: the library's own direction,
	// membership = everything enrolled anywhere.
	private libraryView(): ReciteView {
		const saved = this.plugin.settings.lexLibrary;
		const src = !this.selected
			? this.draft
			: saved ?? {
					from: this.plugin.settings.entityLangs[0] ?? "",
					to: this.plugin.settings.entityLangs.slice(1),
					requireFrom: false,
			  };
		return {
			...emptyView("全部词条"),
			from: src.from,
			to: [...src.to],
			requireFrom: src.requireFrom,
			sort: this.draft.sort,
			group: this.draft.group,
			study: true,
			members: [...this.enrolledIds()],
		};
	}

	// A studied direction came off its short wait while this tab is active.
	// A running session interjects the card; on the workbench the refreshed
	// badges are the notification — no popup either way.
	handleDueDirection(key: string): boolean {
		if (this.playing && this.player)
			return this.player.handleDueDirection(key);
		this.needsRender = true;
		void this.reload();
		return true;
	}

	private boundView(): ReciteView | null {
		return this.views.find((v) => v.name === this.selected) ?? null;
	}

	private selectView(view: ReciteView | null): void {
		this.selected = view?.name ?? null;
		this.draft = view
			? {
					...view,
					to: [...view.to],
					tags: [...view.tags],
					types: [...view.types],
					members: [...view.members],
			  }
			: emptyView();
		if (!view) this.applyLibraryParams();
		this.studyFilter = null;
		this.render();
	}

	private async saveViews(views: ReciteView[]): Promise<void> {
		await this.plugin.store.writeReciteViews(views);
		this.needsRender = true;
		await this.reload();
	}

	// ── filtering ──

	private matchesSearch(e: EntityEntry): boolean {
		if (!this.search) return true;
		const n = this.search;
		return (
			e.id.includes(n) ||
			e.labels.some((l) => l.text.toLowerCase().includes(n)) ||
			e.readings.some((r) => r.text.toLowerCase().includes(n))
		);
	}

	private filtered(): EntityEntry[] {
		let out = [...this.entities.values()].filter(
			(e) => entityMatchesView(e, this.draft) && this.matchesSearch(e)
		);
		if (this.draft.requireFrom && this.draft.from)
			out = out.filter((e) => hasLang(e, this.draft.from));
		const bound = this.boundView();
		if (this.studyFilter && (bound?.study || !this.selected)) {
			const now = new Date();
			const schedule = this.schedule();
			// On the whole-library desk the study segments only cover
			// enrolled words — membership always lives in concrete views.
			const enrolled = this.selected ? null : this.enrolledIds();
			out = out.filter((e) =>
				(!enrolled || enrolled.has(e.id)) &&
				this.draft.to.some((lang) => {
					if (
						lang === this.draft.from ||
						!hasLang(e, lang) ||
						!hasLang(e, this.draft.from)
					)
						return false;
					const rec = this.progress.get(
						progressKey(e.id, this.draft.from, lang)
					);
					switch (this.studyFilter) {
						case "due":
							return isProgressDue(rec, now, schedule);
						case "waiting":
							return isProgressWaiting(rec, now, schedule);
						case "active":
							return !rec || rec.status === "active";
						case "mastered":
							return rec?.status === "mastered";
						default:
							return true;
					}
				})
			);
		}
		return out;
	}

	// ── render ──

	private render(): void {
		this.persistLibraryParams();
		const root = this.contentEl;
		const scroller = root.querySelector(".hl-lex-main");
		const prevScroll = scroller ? scroller.scrollTop : 0;
		root.empty();
		root.addClass("hl-lex-view");
		this.playing = false;
		if (this.player) {
			this.player.unmount();
			this.player = null;
		}
		const shell = root.createDiv({ cls: "hl-lex" });
		this.renderSidebar(shell.createDiv({ cls: "hl-lex-side" }));
		const main = shell.createDiv({ cls: "hl-lex-main" });
		this.renderMain(main);
		if (prevScroll) main.scrollTop = prevScroll;
	}

	// ── sidebar ──

	private renderSidebar(side: HTMLElement): void {
		const searchWrap = side.createDiv({ cls: "hl-lex-search" });
		const searchIcon = searchWrap.createSpan({ cls: "hl-lex-search-icon" });
		setIcon(searchIcon, "search");
		const search = searchWrap.createEl("input", {
			attr: { type: "search", placeholder: "搜索词条，# 选标签…" },
		});
		search.value = this.search;

		// Typing `#` switches the box to tag mode: a dropdown of matching
		// tags, ↑↓ + Enter (or click) toggles the tag filter like a sidebar
		// click would.
		const allTagCounts = new Map<string, number>();
		for (const e of this.entities.values())
			for (const t of e.tags) {
				const k = normTag(t);
				if (!k) continue;
				const parts = k.split("/");
				for (let i = 1; i <= parts.length; i++) {
					const p = parts.slice(0, i).join("/");
					allTagCounts.set(p, (allTagCounts.get(p) ?? 0) + 1);
				}
			}
		const sug = searchWrap.createDiv({ cls: "hl-lex-sug" });
		let sugIdx = 0;
		let sugOpts: string[] = [];
		const pickTag = (tag: string): void => {
			const on = this.draft.tags.some((t) => normTag(t) === tag);
			this.draft.tags = on
				? this.draft.tags.filter((t) => normTag(t) !== tag)
				: [...this.draft.tags, tag];
			this.render();
			const again = this.contentEl.querySelector<HTMLInputElement>(
				".hl-lex-search input"
			);
			again?.focus();
		};
		const renderSug = (): void => {
			sug.empty();
			const v = search.value.trim();
			if (!v.startsWith("#")) {
				sug.removeClass("is-open");
				return;
			}
			const q = normTag(v).toLowerCase();
			sugOpts = [...allTagCounts.keys()]
				.filter((t) => t.toLowerCase().includes(q))
				.sort(
					(a, b) =>
						(allTagCounts.get(b) ?? 0) -
						(allTagCounts.get(a) ?? 0)
				)
				.slice(0, 8);
			if (!sugOpts.length) {
				sug.removeClass("is-open");
				return;
			}
			if (sugIdx >= sugOpts.length) sugIdx = 0;
			sug.addClass("is-open");
			sugOpts.forEach((tag, i) => {
				const on = this.draft.tags.some(
					(t) => normTag(t) === tag
				);
				const item = sug.createDiv({
					cls: `hl-lex-sug-item${i === sugIdx ? " is-sel" : ""}${
						on ? " is-on" : ""
					}`,
				});
				item.createSpan({ text: `#${tag}` });
				item.createSpan({
					cls: "hl-lex-side-cnt",
					text: String(allTagCounts.get(tag)),
				});
				// mousedown, so the input doesn't lose focus first
				item.addEventListener("mousedown", (ev) => {
					ev.preventDefault();
					pickTag(tag);
				});
			});
		};
		search.addEventListener("keydown", (ev) => {
			if (!sug.hasClass("is-open")) return;
			if (ev.key === "ArrowDown") {
				sugIdx = (sugIdx + 1) % sugOpts.length;
				renderSug();
				ev.preventDefault();
			} else if (ev.key === "ArrowUp") {
				sugIdx = (sugIdx + sugOpts.length - 1) % sugOpts.length;
				renderSug();
				ev.preventDefault();
			} else if (ev.key === "Enter") {
				pickTag(sugOpts[sugIdx]);
				ev.preventDefault();
			} else if (ev.key === "Escape") {
				search.value = "";
				renderSug();
				ev.preventDefault();
			}
		});

		let timer = 0;
		search.addEventListener("input", () => {
			window.clearTimeout(timer);
			if (search.value.trim().startsWith("#")) {
				sugIdx = 0;
				renderSug();
				return;
			}
			renderSug();
			timer = window.setTimeout(() => {
				this.search = search.value.trim().toLowerCase();
				this.render();
				const again =
					this.contentEl.querySelector<HTMLInputElement>(
						".hl-lex-search input"
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

		// views — the whole library is the fixed first entry
		side.createDiv({ cls: "hl-lex-side-label", text: "视图" });
		const schedule = this.schedule();
		const all = side.createDiv({
			cls: `hl-lex-side-item${this.selected === null ? " is-on" : ""}`,
		});
		all.createSpan({ cls: "hl-lex-side-name", text: "全部词条" });
		const lib = this.libraryView();
		const libDue = lib.members.length
			? lexStudyStats(
					lib,
					this.entities.values(),
					this.progress,
					schedule
			  ).words.due
			: 0;
		if (libDue > 0)
			all.createSpan({
				cls: "hl-lex-side-due",
				text: String(libDue),
			});
		else
			all.createSpan({
				cls: "hl-lex-side-cnt",
				text: String(this.entities.size),
			});
		all.addEventListener("click", () => this.selectView(null));
		for (const view of this.views) {
			const item = side.createDiv({
				cls: `hl-lex-side-item${
					this.selected === view.name ? " is-on" : ""
				}`,
			});
			const nm = item.createSpan({ cls: "hl-lex-side-name" });
			nm.createSpan({ text: view.name });
			const dir = dirLabel(view);
			if (dir) {
				nm.createSpan({ cls: "hl-lex-side-dir", text: dir });
				nm.setAttr("aria-label", dir);
			}
			if (view.study) {
				const stats = lexStudyStats(
					view,
					this.entities.values(),
					this.progress,
					schedule
				);
				if (stats.words.due > 0)
					item.createSpan({
						cls: "hl-lex-side-due",
						text: String(stats.words.due),
					});
				else
					item.createSpan({
						cls: "hl-lex-side-cnt",
						text: String(
							stats.words.active + stats.words.mastered
						),
					});
			} else {
				const count = [...this.entities.values()].filter((e) =>
					entityMatchesView(e, view)
				).length;
				item.createSpan({
					cls: "hl-lex-side-cnt",
					text: String(count),
				});
			}
			item.addEventListener("click", () => this.selectView(view));
			item.addEventListener("contextmenu", (ev) =>
				this.viewMenu(view, ev)
			);
		}

		// tag tree with counts (within current type/search scope)
		const facetBase = [...this.entities.values()].filter((e) =>
			this.matchesSearch(e)
		);
		const tagCounts = new Map<string, number>();
		for (const e of facetBase)
			for (const t of e.tags) {
				const k = normTag(t);
				if (!k) continue;
				// Credit every ancestor so parents aggregate children.
				const parts = k.split("/");
				for (let i = 1; i <= parts.length; i++) {
					const prefix = parts.slice(0, i).join("/");
					tagCounts.set(prefix, (tagCounts.get(prefix) ?? 0) + 1);
				}
			}
		if (tagCounts.size) {
			side.createDiv({ cls: "hl-lex-side-label", text: "标签" });
			const sorted = [...tagCounts.keys()].sort((a, b) =>
				a.localeCompare(b, "zh")
			);
			for (const tag of sorted) {
				const depth = tag.split("/").length - 1;
				const on = this.draft.tags.some((t) => normTag(t) === tag);
				const item = side.createDiv({
					cls: `hl-lex-side-item${on ? " is-on" : ""}`,
				});
				item.style.paddingLeft = `${16 + depth * 14}px`;
				item.createSpan({
					cls: "hl-lex-side-name",
					text: `#${tag.split("/").pop()}`,
				});
				item.createSpan({
					cls: "hl-lex-side-cnt",
					text: String(tagCounts.get(tag)),
				});
				item.addEventListener("click", () => {
					this.draft.tags = on
						? this.draft.tags.filter((t) => normTag(t) !== tag)
						: [...this.draft.tags, tag];
					this.render();
				});
			}
		}

		// types
		const typeCounts = new Map<string, number>();
		for (const e of facetBase)
			if (e.type)
				typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
		if (typeCounts.size) {
			side.createDiv({ cls: "hl-lex-side-label", text: "类型" });
			for (const [type, count] of [...typeCounts.entries()].sort(
				(a, b) => b[1] - a[1]
			)) {
				const on = this.draft.types.includes(type);
				const item = side.createDiv({
					cls: `hl-lex-side-item${on ? " is-on" : ""}`,
				});
				item.createSpan({ cls: "hl-lex-side-name", text: type });
				item.createSpan({
					cls: "hl-lex-side-cnt",
					text: String(count),
				});
				item.addEventListener("click", () => {
					this.draft.types = on
						? this.draft.types.filter((t) => t !== type)
						: [...this.draft.types, type];
					this.render();
				});
			}
		}
	}

	private viewMenu(view: ReciteView, ev: MouseEvent): void {
		ev.preventDefault();
		const menu = new Menu();
		// Overwrites the view's filters/params with the current desk; its
		// name, study flag and membership stay untouched.
		menu.addItem((i) =>
			i
				.setTitle("更新为当前筛选")
				.setIcon("save")
				.onClick(() =>
					void this.saveViews(
						this.views.map((v) =>
							v.name === view.name
								? {
										...v,
										from: this.draft.from,
										to: [...this.draft.to],
										tags: [...this.draft.tags],
										types: [...this.draft.types],
										requireFrom: this.draft.requireFrom,
										sort: this.draft.sort,
										group: this.draft.group,
								  }
								: v
						)
					).then(() => new Notice(`已更新「${view.name}」`))
				)
		);
		menu.addItem((i) =>
			i
				.setTitle("重命名")
				.setIcon("pencil")
				.onClick(() =>
					new NameModal(this.app, "重命名视图", view.name, (name) => {
						if (
							name !== view.name &&
							this.views.some((v) => v.name === name)
						) {
							new Notice("已有同名视图");
							return;
						}
						if (this.selected === view.name) this.selected = name;
						void this.saveViews(
							this.views.map((v) =>
								v.name === view.name ? { ...v, name } : v
							)
						);
					}).open()
				)
		);
		if (view.study)
			menu.addItem((i) =>
				i
					.setTitle("停止学习（进度保留）")
					.setIcon("pause")
					.onClick(() =>
						void this.saveViews(
							this.views.map((v) =>
								v.name === view.name
									? { ...v, study: false }
									: v
							)
						)
					)
			);
		menu.addItem((i) =>
			i
				.setTitle("删除视图")
				.setIcon("trash")
				.onClick(() =>
					new ConfirmModal(
						this.app,
						"删除视图",
						`删除「${view.name}」？学习进度记录会保留。`,
						"删除",
						() => {
							if (this.selected === view.name)
								this.selected = null;
							void this.saveViews(
								this.views.filter(
									(v) => v.name !== view.name
								)
							);
						}
					).open()
				)
		);
		menu.showAtMouseEvent(ev);
	}

	// ── main column ──

	private renderMain(main: HTMLElement): void {
		const items = this.filtered();
		this.renderToolrow(main, items.length);
		this.renderStudyStrip(main);
		this.renderEntries(main, items);
		if (this.selectMode) this.renderSelectBar(main);
	}

	private renderToolrow(main: HTMLElement, count: number): void {
		const row = main.createDiv({ cls: "hl-lex-toolrow" });
		row.createEl("h1", {
			text: this.selected ?? "全部词条",
		});
		// Desk differs from the saved view: a restore icon right by the
		// title drops the draft and returns to the view's own filters.
		const boundEarly = this.boundView();
		if (
			boundEarly &&
			JSON.stringify({ ...this.draft, members: [] }) !==
				JSON.stringify({ ...boundEarly, members: [] })
		) {
			const reset = row.createSpan({ cls: "hl-lex-dirty" });
			setIcon(reset, "rotate-ccw");
			reset.setAttr("aria-label", "筛选已修改 · 点击恢复视图原筛选");
			reset.addEventListener("click", () =>
				this.selectView(boundEarly)
			);
		}
		row.createSpan({ cls: "hl-lex-total", text: `${count} 个词条` });
		row.createSpan({ cls: "hl-lex-tsep", text: "·" });

		// direction: from → to
		const dir = row.createSpan({ cls: "hl-lex-tctl" });
		dir.createSpan({
			text: this.draft.from ? langDisplayName(this.draft.from) : "出发语言",
		});
		dir.createSpan({ cls: "hl-lex-arrow", text: " → " });
		dir.createSpan({
			cls: "hl-lex-strong",
			text: this.draft.to.length
				? orderLangs(this.draft.to).map(langDisplayName).join(" / ")
				: "目标语言",
		});
		dir.addEventListener("click", (ev) => this.directionMenu(ev));

		row.createSpan({ cls: "hl-lex-tsep", text: "·" });
		const sort = row.createSpan({ cls: "hl-lex-tctl" });
		const sortNames: Record<ViewSort, string> = {
			created: "加入时间",
			updated: "更新时间",
			name: "名称",
		};
		sort.createSpan({ text: "按" });
		sort.createSpan({
			cls: "hl-lex-strong",
			text: sortNames[this.draft.sort],
		});
		sort.addEventListener("click", (ev) => {
			const menu = new Menu();
			for (const [v, t] of Object.entries(sortNames))
				menu.addItem((i) =>
					i
						.setTitle(t)
						.setChecked(this.draft.sort === v)
						.onClick(() => {
							this.draft.sort = v as ViewSort;
							this.render();
						})
				);
			menu.showAtMouseEvent(ev);
		});

		const group = row.createSpan({ cls: "hl-lex-tctl" });
		const groupNames: Record<ViewGroup, string> = {
			none: "不分组",
			date: "按日期分组",
			type: "按类型分组",
			tag: "按标签分组",
		};
		group.createSpan({
			cls: "hl-lex-strong",
			text: groupNames[this.draft.group],
		});
		group.addEventListener("click", (ev) => {
			const menu = new Menu();
			for (const [v, t] of Object.entries(groupNames))
				menu.addItem((i) =>
					i
						.setTitle(t)
						.setChecked(this.draft.group === v)
						.onClick(() => {
							this.draft.group = v as ViewGroup;
							this.render();
						})
				);
			menu.showAtMouseEvent(ev);
		});

		row.createDiv({ cls: "hl-lex-spacer" });

		const pick = row.createSpan({
			cls: `hl-lex-tctl${this.selectMode ? " is-on" : ""}`,
			text: "选择",
		});
		pick.addEventListener("click", () => {
			this.selectMode = !this.selectMode;
			if (!this.selectMode) this.selectedIds.clear();
			this.render();
		});

		// The button only ever saves the current filters as a NEW view;
		// updating an existing view goes through its context menu.
		const bound = this.boundView();
		const dirty = bound
			? JSON.stringify({
					...this.draft,
					members: [],
			  }) !==
			  JSON.stringify({
					...bound,
					members: [],
			  })
			: this.draft.tags.length > 0 ||
			  this.draft.types.length > 0;
		if (dirty) {
			const save = row.createEl("button", {
				cls: "hl-lex-save",
				text: "存为视图",
			});
			save.addEventListener("click", () => {
				new NameModal(this.app, "存为新视图", "", (name) => {
					if (this.views.some((v) => v.name === name)) {
						new Notice("已有同名视图");
						return;
					}
					this.selected = name;
					void this.saveViews([
						...this.views,
						{
							...this.draft,
							name,
							members: [...this.draft.members],
						},
					]).then(() => new Notice(`已保存「${name}」`));
				}).open();
			});
		}
	}

	private directionMenu(ev: MouseEvent): void {
		const langs = this.plugin.settings.entityLangs;
		const menu = new Menu();
		for (const lang of langs)
			menu.addItem((i) =>
				i
					.setTitle(`出发语言：${langDisplayName(lang)}`)
					.setChecked(this.draft.from === lang)
					.onClick(() => {
						this.draft.from = lang;
						this.draft.to = this.draft.to.filter(
							(l) => l !== lang
						);
						this.render();
					})
			);
		menu.addSeparator();
		for (const lang of langs) {
			if (lang === this.draft.from) continue;
			const on = this.draft.to.includes(lang);
			menu.addItem((i) =>
				i
					.setTitle(`目标：${langDisplayName(lang)}`)
					.setChecked(on)
					.onClick(() => {
						this.draft.to = on
							? this.draft.to.filter((l) => l !== lang)
							: [...this.draft.to, lang];
						this.render();
					})
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("只看有出发语言的")
				.setChecked(this.draft.requireFrom)
				.onClick(() => {
					this.draft.requireFrom = !this.draft.requireFrom;
					this.render();
				})
		);
		menu.showAtMouseEvent(ev);
	}

	// ── study strip ──

	private renderStudyStrip(main: HTMLElement): void {
		const bound = this.boundView();
		// The whole-library desk gets the same strip: a read/study surface
		// over everything enrolled anywhere, in its own direction.
		const deck = bound ?? this.libraryView();
		if (bound && !bound.study) {
			const strip = main.createDiv({ cls: "hl-lex-strip is-idle" });
			strip.createSpan({
				cls: "hl-lex-strip-invite",
				text: "悬停词条按 ＋ 加入学习，第一张卡自动开始",
			});
			return;
		}
		if (!bound && !deck.members.length) {
			const strip = main.createDiv({ cls: "hl-lex-strip is-idle" });
			strip.createSpan({
				cls: "hl-lex-strip-invite",
				text: "还没有词条加入学习——悬停词条按 ＋ 加进一个视图",
			});
			return;
		}
		const stats = lexStudyStats(
			deck,
			this.entities.values(),
			this.progress,
			this.schedule()
		);
		const strip = main.createDiv({ cls: "hl-lex-strip" });
		const icon = strip.createSpan({ cls: "hl-lex-strip-icon" });
		setIcon(icon, "brain");
		// Words first, direction keys as fine print: «到期 2 词 · 3 方向».
		const seg = (
			key: Exclude<StudyFilter, null>,
			label: string,
			words: number,
			dirs: number
		): void => {
			const el = strip.createSpan({
				cls: `hl-lex-strip-seg${
					this.studyFilter === key ? " is-on" : ""
				}`,
			});
			el.createSpan({ cls: "hl-lex-strip-num", text: String(words) });
			el.createSpan({ text: label });
			if (dirs !== words)
				el.createSpan({
					cls: "hl-lex-strip-dirs",
					text: `${dirs} 方向`,
				});
			el.addEventListener("click", () => {
				this.studyFilter = this.studyFilter === key ? null : key;
				this.render();
			});
		};
		seg("due", "到期", stats.words.due, stats.due);
		seg("waiting", "短等待", stats.words.waiting, stats.waiting);
		seg("active", "在学", stats.words.active, stats.active);
		seg("mastered", "学过", stats.words.mastered, stats.mastered);
		if (!bound) {
			// Words in the library never enrolled anywhere: grey, not due.
			const enrolled = new Set(deck.members);
			const fresh = [...this.entities.values()].filter(
				(e) =>
					!enrolled.has(e.id) &&
					hasLang(e, deck.from) &&
					deck.to.some(
						(l) => l !== deck.from && hasLang(e, l)
					)
			).length;
			if (fresh > 0) {
				const el = strip.createSpan({
					cls: "hl-lex-strip-seg is-rest",
				});
				el.createSpan({
					cls: "hl-lex-strip-num",
					text: String(fresh),
				});
				el.createSpan({ text: "未开始" });
				el.setAttr("aria-label", "还没加入任何学习视图的词条");
			}
		}
		strip.createDiv({ cls: "hl-lex-spacer" });
		if (stats.words.due > 0) {
			const go = strip.createEl("button", {
				cls: "mod-cta",
				text: `开始复习 ${stats.words.due}`,
			});
			go.addEventListener("click", () => this.startStudy(deck, true));
		} else if (stats.active > 0) {
			const go = strip.createEl("button", {
				cls: "hl-lex-ghost",
				text: "提前复习",
			});
			go.addEventListener("click", () => this.startStudy(deck, false));
		} else {
			strip.createSpan({
				cls: "hl-lex-strip-done",
				text: "都完成了 ✓",
			});
		}
	}

	// ── entry list ──

	private renderEntries(main: HTMLElement, items: EntityEntry[]): void {
		if (!items.length) {
			main.createDiv({
				cls: "hl-lex-empty",
				text: "没有符合筛选的词条。",
			});
			return;
		}
		this.ensureContexts(items);
		const groups = this.grouped(items);
		for (const g of groups) {
			if (g.label)
				main.createDiv({
					cls: "hl-lex-ghead",
					text: `${g.label} · ${g.items.length}`,
				});
			for (const e of g.items) this.renderEntry(main, e);
		}
	}

	private grouped(
		items: EntityEntry[]
	): { label: string; items: EntityEntry[] }[] {
		const sort = this.draft.sort;
		const sorted = [...items].sort((a, b) => {
			if (sort === "name")
				return displayName(a).localeCompare(displayName(b), "zh");
			if (sort === "updated")
				return (b.updated ?? "").localeCompare(a.updated ?? "");
			return entityStamp(b).localeCompare(entityStamp(a));
		});
		const group = this.draft.group;
		if (group === "none") return [{ label: "", items: sorted }];
		const buckets = new Map<string, EntityEntry[]>();
		const labels = new Map<string, string>();
		for (const e of sorted) {
			let key: string;
			if (group === "date") {
				const bucket = dateBucket(entityStamp(e));
				key = bucket.rank;
				labels.set(key, bucket.label);
			} else {
				key =
					group === "type"
						? e.type || "未分类"
						: normTag(e.tags[0] ?? "") || "无标签";
				labels.set(key, key);
			}
			const list = buckets.get(key) ?? [];
			list.push(e);
			buckets.set(key, list);
		}
		return [...buckets.entries()]
			.sort((a, b) =>
				group === "date"
					? a[0].localeCompare(b[0])
					: a[0].localeCompare(b[0], "zh")
			)
			.map(([key, list]) => ({
				label: labels.get(key) ?? key,
				items: list,
			}));
	}

	private renderEntry(main: HTMLElement, e: EntityEntry): void {
		const bound = this.boundView();
		const schedule = this.schedule();
		const now = new Date();
		const picked = this.selectedIds.has(e.id);
		const entry = main.createDiv({
			cls: `hl-lex-entry${this.selectMode ? " is-selecting" : ""}${
				picked ? " is-picked" : ""
			}`,
		});
		if (this.selectMode) {
			const tick = entry.createDiv({ cls: "hl-lex-tick" });
			setIcon(tick, picked ? "check-circle-2" : "circle");
			entry.addEventListener("click", () => {
				if (this.selectedIds.has(e.id))
					this.selectedIds.delete(e.id);
				else this.selectedIds.add(e.id);
				this.render();
			});
		}

		// head: word + reading + type + hover actions
		const head = entry.createDiv({ cls: "hl-lex-ehead" });
		const front = this.draft.from
			? e.labels.find(
					(l) => l.lang === this.draft.from && l.text.trim()
			  )
			: undefined;
		head.createSpan({
			cls: `hl-lex-word${front ? "" : " is-missing"}`,
			text: front ? front.text : displayName(e),
		});
		if (front) {
			const reading = e.readings.find(
				(r) => r.lang === this.draft.from && r.text.trim()
			);
			if (reading)
				head.createSpan({
					cls: "hl-lex-reading",
					text: reading.text,
				});
			// The headword is never masked, so its pronunciation can sit
			// in the open — unlike target rows, which reveal theirs.
			const audio = e.audios.find(
				(a) => a.lang === this.draft.from
			);
			if (audio) {
				const play = head.createSpan({ cls: "hl-lex-audio" });
				setIcon(play, "volume-2");
				play.setAttr("aria-label", "播放发音");
				play.addEventListener("click", (ev) => {
					ev.stopPropagation();
					playEntityAudio(this.plugin, audio.link);
				});
			}
		} else if (this.draft.from)
			head.setAttr(
				"aria-label",
				`缺 ${langDisplayName(this.draft.from)} 拼写`
			);
		if (e.type) head.createSpan({ cls: "hl-lex-etype", text: e.type });
		const acts = head.createDiv({ cls: "hl-lex-eacts" });
		const target = this.plusTarget();
		const isMember =
			target != null &&
			((target.follow && entityMatchesView(e, target)) ||
				target.members.includes(e.id));
		if (!isMember) {
			const add = acts.createSpan({ cls: "hl-lex-eact" });
			setIcon(add, "plus");
			add.setAttr(
				"aria-label",
				target ? `加入「${target.name}」学习` : "加入学习…"
			);
			add.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.addToStudy([e.id], ev);
			});
		} else if (target && target.members.includes(e.id)) {
			const rm = acts.createSpan({ cls: "hl-lex-eact" });
			setIcon(rm, "minus");
			rm.setAttr("aria-label", "移出学习（进度保留）");
			rm.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.removeFromStudy(target, [e.id]);
			});
		}
		const edit = acts.createSpan({ cls: "hl-lex-eact" });
		setIcon(edit, "pencil");
		edit.setAttr("aria-label", "编辑词条");
		edit.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.editEntity(e);
		});

		// language rows
		const langsBox = entry.createDiv({ cls: "hl-lex-langs" });
		for (const lang of orderLangs(
			this.draft.to.filter((l) => l !== this.draft.from)
		))
			this.renderLangRow(langsBox, e, lang, bound, schedule, now);

		// context
		this.renderContext(entry, e);

		// meta
		const meta = entry.createDiv({ cls: "hl-lex-emeta" });
		for (const t of e.tags)
			meta.createSpan({ text: `#${normTag(t)}` });
		const added = addedLabel(entityStamp(e));
		if (added) meta.createSpan({ text: added });
	}

	private renderLangRow(
		host: HTMLElement,
		e: EntityEntry,
		lang: string,
		bound: ReciteView | null,
		schedule: QuizSchedule,
		now: Date
	): void {
		const row = host.createDiv({ cls: "hl-lex-lrow" });
		this.fillLangRow(row, e, lang, bound, schedule, now);
	}

	private fillLangRow(
		row: HTMLElement,
		e: EntityEntry,
		lang: string,
		bound: ReciteView | null,
		schedule: QuizSchedule,
		now: Date
	): void {
		row.createSpan({
			cls: "hl-lex-lname",
			text: langDisplayName(lang),
		});
		const label = e.labels.find(
			(l) => l.lang === lang && l.text.trim()
		);
		if (!label) {
			// missing spelling: a faint dashed blank; hover reveals a ghost
			// «+» that opens the editor to fill it in.
			const blank = row.createSpan({ cls: "hl-lex-blank" });
			blank.setAttr(
				"aria-label",
				`缺 ${langDisplayName(lang)} 拼写 · 点击补全`
			);
			const plus = blank.createSpan({ cls: "hl-lex-blank-plus" });
			setIcon(plus, "plus");
			blank.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.editEntity(e);
			});
			return;
		}
		const key = `${e.id}:${lang}`;
		const revealed = this.revealed.has(key);
		const word = row.createSpan({
			cls: `hl-lex-answer hl-db-ref${revealed ? "" : " hl-db-mask"}`,
		});
		word.createSpan({ text: label.text });
		const aliases = e.labels
			.filter(
				(l) =>
					l.lang === lang &&
					l.text.trim() &&
					l.text !== label.text
			)
			.map((l) => l.text);
		if (aliases.length)
			word.createSpan({
				cls: "hl-db-aliases",
				text: `／${aliases.join("／")}`,
			});
		word.setAttr("aria-label", revealed ? "点击遮住" : "点击揭开");
		// Rebuild the row on toggle so the revealed extras (reading, audio)
		// come and go with the mask, and repeated clicks stay in sync.
		word.addEventListener("click", (ev) => {
			ev.stopPropagation();
			if (this.revealed.has(key)) this.revealed.delete(key);
			else this.revealed.add(key);
			row.empty();
			this.fillLangRow(row, e, lang, bound, schedule, new Date());
		});
		if (revealed) {
			const reading = e.readings.find(
				(r) => r.lang === lang && r.text.trim()
			);
			if (reading)
				row.createSpan({
					cls: "hl-lex-reading",
					text: reading.text,
				});
			const audio = e.audios.find((a) => a.lang === lang);
			if (audio) {
				const play = row.createSpan({ cls: "hl-lex-audio" });
				setIcon(play, "volume-2");
				play.setAttr("aria-label", "播放发音");
				play.addEventListener("click", (ev) => {
					ev.stopPropagation();
					playEntityAudio(this.plugin, audio.link);
				});
			}
		}
		// mastery dots for studied directions
		if (bound?.study && this.draft.from && hasLang(e, this.draft.from)) {
			const rec = this.progress.get(
				progressKey(e.id, this.draft.from, lang)
			);
			const dots = row.createSpan({ cls: "hl-lex-dots" });
			const steps = Math.max(1, schedule.masterySteps);
			const p =
				rec?.status === "mastered" ? steps : rec?.progress ?? 0;
			for (let i = 0; i < steps; i++)
				dots.createSpan({
					cls: `hl-lex-dot${i < p ? " is-f" : ""}`,
				});
			if (rec?.status === "mastered") dots.addClass("is-done");
			if (rec && isProgressDue(rec, now, schedule))
				dots.createSpan({ cls: "hl-lex-dot is-due" });
			dots.setAttr(
				"aria-label",
				rec?.status === "mastered"
					? "已学过"
					: `掌握 ${p}/${steps}`
			);
		}
	}

	// ── context ──

	private ensureContexts(items: EntityEntry[]): void {
		if (this.contexts || this.ctxLoading) return;
		this.ctxLoading = true;
		void contextHintsForMany(this.plugin, items).then((map) => {
			this.ctxLoading = false;
			this.contexts = map;
			// Patch the placeholder rows in place — no full re-render.
			for (const el of Array.from(
				this.contentEl.querySelectorAll<HTMLElement>(
					".hl-lex-ctx[data-entity]"
				)
			)) {
				const id = el.getAttr("data-entity");
				const entity = id ? this.entities.get(id) : undefined;
				if (!entity) continue;
				el.empty();
				this.fillContext(el, entity);
			}
		});
	}

	private renderContext(entry: HTMLElement, e: EntityEntry): void {
		const box = entry.createDiv({ cls: "hl-lex-ctx" });
		box.setAttr("data-entity", e.id);
		this.fillContext(box, e);
	}

	private fillContext(box: HTMLElement, e: EntityEntry): void {
		if (!this.contexts) {
			box.createSpan({ cls: "hl-lex-ctx-none", text: "…" });
			return;
		}
		const hints = this.contexts.get(e.id) ?? [];
		if (!hints.length) {
			box.createSpan({ cls: "hl-lex-ctx-none", text: "暂无语境" });
			return;
		}
		const expanded = this.ctxOpen.has(e.id);
		const idx = (this.ctxIndex.get(e.id) ?? 0) % hints.length;
		const hint = hints[idx];
		const quote = box.createSpan({
			cls: `hl-lex-ctx-q${expanded ? " is-open" : ""}`,
		});
		quote.createSpan({ cls: "hl-lex-ctx-mark", text: "「" });
		renderContextMarkdown(
			this.plugin,
			hint.raw,
			e.id,
			quote.createSpan({ cls: "hl-lex-ctx-body" }),
			this.colors,
			hint.kind === "note" ? hint.path : ""
		);
		quote.createSpan({ cls: "hl-lex-ctx-mark", text: "」" });
		// clicking the quote (not an entity span) expands / collapses
		quote.addEventListener("click", (ev) => {
			ev.stopPropagation();
			if (this.ctxOpen.has(e.id)) this.ctxOpen.delete(e.id);
			else this.ctxOpen.add(e.id);
			box.empty();
			this.fillContext(box, e);
		});
		if (hints.length > 1) {
			const pager = box.createSpan({
				cls: "hl-lex-ctx-pager",
				text: `${idx + 1} / ${hints.length} ›`,
			});
			pager.setAttr("aria-label", "换一条语境");
			pager.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.ctxIndex.set(e.id, idx + 1);
				box.empty();
				this.fillContext(box, e);
			});
		}
		const src = box.createSpan({ cls: "hl-lex-ctx-src" });
		const srcIcon = src.createSpan();
		setIcon(
			srcIcon,
			hint.kind === "note" ? "file-text" : "gantt-chart"
		);
		src.createSpan({ text: hint.source });
		src.setAttr(
			"aria-label",
			hint.kind === "note" ? "跳到笔记原文" : "在时间线上显示"
		);
		src.addEventListener("click", (ev) => {
			ev.stopPropagation();
			if (hint.kind === "note")
				void jumpToLocation(
					this.app,
					hint.path,
					hint.offset,
					hint.length
				);
			else void this.plugin.revealOnTimeline(hint.evId, hint.tag);
		});
	}

	private editEntity(e: EntityEntry): void {
		new EntityModal(this.app, this.plugin, e, false, () => {
			this.queueReload();
		}).open();
	}

	// ── study membership ──

	// The deck a bare «+» lands in: the current view (even when its filters
	// were tweaked afterwards), else the view that last received members.
	private plusTarget(): ReciteView | null {
		return (
			this.boundView() ??
			this.views.find((v) => v.name === this.lastTarget) ??
			null
		);
	}

	private addToStudy(ids: string[], ev?: MouseEvent): void {
		const target = this.plusTarget();
		if (target) {
			void this.addMembers(target, ids);
			return;
		}
		const menu = new Menu();
		// Views covering the direction being browsed come first; the rest
		// stay selectable but carry a soft “方向不同” hint.
		const covers = (v: ReciteView): boolean =>
			v.from === this.draft.from &&
			this.draft.to.some(
				(l) => l !== this.draft.from && v.to.includes(l)
			);
		const ordered = [...this.views].sort(
			(a, b) => Number(covers(b)) - Number(covers(a))
		);
		for (const v of ordered)
			menu.addItem((i) =>
				i
					.setTitle(
						createFragment((f) => {
							f.createSpan({ text: `加入「${v.name}」` });
							const dir = dirLabel(v);
							if (dir)
								f.createSpan({
									cls: "hl-lex-menu-dir",
									text: dir,
								});
							if (!covers(v))
								f.createSpan({
									cls: "hl-lex-menu-warn",
									text: "方向不同",
								});
						})
					)
					.setIcon(v.study ? "brain" : "bookmark")
					.onClick(() => void this.addMembers(v, ids))
			);
		if (this.views.length) menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("保存为新视图并加入…")
				.setIcon("plus")
				.onClick(() =>
					new NameModal(this.app, "保存视图", "", (name) => {
						if (this.views.some((v) => v.name === name)) {
							new Notice("已有同名视图");
							return;
						}
						const view = { ...this.draft, name };
						this.selected = name;
						this.views = [...this.views, view];
						void this.addMembers(view, ids);
					}).open()
				)
		);
		if (ev) menu.showAtMouseEvent(ev);
	}

	private async addMembers(
		view: ReciteView,
		ids: string[]
	): Promise<void> {
		if (!view.from || !view.to.length) {
			new Notice("先在工具行选择出发语言和目标语言");
			return;
		}
		const add = ids.filter((id) => !view.members.includes(id));
		this.lastTarget = view.name;
		if (!add.length && view.study) {
			new Notice("已在学习中");
			return;
		}
		await this.saveViews(
			this.views.map((v) =>
				v.name === view.name
					? {
							...v,
							study: true,
							members: [...v.members, ...add],
					  }
					: v
			)
		);
		new Notice(`已加入「${view.name}」· ${add.length} 个词条`);
	}

	private removeFromStudy(view: ReciteView, ids: string[]): void {
		const drop = new Set(ids);
		void this.saveViews(
			this.views.map((v) =>
				v.name === view.name
					? {
							...v,
							members: v.members.filter(
								(id) => !drop.has(id)
							),
					  }
					: v
			)
		).then(() => new Notice("已移出学习（进度保留）"));
	}

	// ── multi-select ──

	private renderSelectBar(main: HTMLElement): void {
		const bar = main.createDiv({ cls: "hl-lex-selbar" });
		const close = bar.createSpan({ cls: "hl-lex-selbar-act" });
		setIcon(close, "x");
		close.setAttr("aria-label", "退出多选（Esc）");
		close.addEventListener("click", () => {
			this.selectMode = false;
			this.selectedIds.clear();
			this.render();
		});
		bar.createSpan({
			cls: "hl-lex-selbar-count",
			text: `已选 ${this.selectedIds.size}`,
		});
		const act = (label: string, fn: (ev: MouseEvent) => void): void => {
			const el = bar.createSpan({
				cls: "hl-lex-selbar-act",
				text: label,
			});
			el.addEventListener("click", (ev) => {
				if (!this.selectedIds.size) {
					new Notice("先勾选词条");
					return;
				}
				fn(ev);
			});
		};
		act("加入学习", (ev) =>
			this.addToStudy([...this.selectedIds], ev)
		);
		const target = this.plusTarget();
		if (target?.study)
			act("移出学习", () =>
				this.removeFromStudy(target, [...this.selectedIds])
			);
		act("打标签…", () =>
			new NameModal(this.app, "给选中词条打标签", "", (tag) =>
				void this.batchEdit((e) => {
					const k = normTag(tag);
					if (!e.tags.some((t) => normTag(t) === k))
						e.tags.push(k);
				})
			).open()
		);
		const more = bar.createSpan({ cls: "hl-lex-selbar-act" });
		setIcon(more, "ellipsis");
		more.addEventListener("click", (ev) => {
			if (!this.selectedIds.size) {
				new Notice("先勾选词条");
				return;
			}
			this.selectMoreMenu(ev);
		});
	}

	private selectMoreMenu(ev: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("移除标签…")
				.setIcon("tag")
				.onClick(() =>
					new NameModal(this.app, "从选中词条移除标签", "", (tag) =>
						void this.batchEdit((e) => {
							const k = normTag(tag);
							e.tags = e.tags.filter(
								(t) => normTag(t) !== k
							);
						})
					).open()
				)
		);
		menu.addItem((i) =>
			i
				.setTitle("改类型…")
				.setIcon("shapes")
				.onClick(() =>
					new NameModal(this.app, "设置类型", "", (type) =>
						void this.batchEdit((e) => {
							e.type = type.trim();
						})
					).open()
				)
		);
		menu.addItem((i) =>
			i
				.setTitle("复制 ID 列表")
				.setIcon("copy")
				.onClick(() => {
					void navigator.clipboard?.writeText(
						[...this.selectedIds].join("\n")
					);
					new Notice(`已复制 ${this.selectedIds.size} 个 ID`);
				})
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("删除词条…")
				.setIcon("trash")
				.onClick(() =>
					new ConfirmModal(
						this.app,
						"删除词条",
						`删除选中的 ${this.selectedIds.size} 个词条？笔记里的标记会失去引用。`,
						"删除",
						() => void this.deleteSelected()
					).open()
				)
		);
		menu.showAtMouseEvent(ev);
	}

	private async batchEdit(
		mutate: (e: EntityEntry) => void
	): Promise<void> {
		const stamp = new Date().toISOString();
		for (const id of this.selectedIds) {
			const e = this.entities.get(id);
			if (!e) continue;
			mutate(e);
			e.updated = stamp;
		}
		await this.plugin.store.writeEntities(this.entities);
		new Notice(`已更新 ${this.selectedIds.size} 个词条`);
		this.needsRender = true;
		await this.reload();
	}

	private async deleteSelected(): Promise<void> {
		for (const id of this.selectedIds) this.entities.delete(id);
		await this.plugin.store.writeEntities(this.entities);
		new Notice(`已删除 ${this.selectedIds.size} 个词条`);
		this.selectedIds.clear();
		this.needsRender = true;
		await this.reload();
	}

	// ── study session ──

	private startStudy(view: ReciteView, dueOnly: boolean): void {
		const schedule = this.schedule();
		const now = new Date();
		const items: StudyItem[] = [];
		for (const entity of studyMembers(this.entities.values(), view)) {
			// A language never quizzes itself: from→from is not a direction.
			const langs = view.to
				.filter((lang) => lang !== view.from && hasLang(entity, lang))
				.map((lang) => {
					const rec = this.progress.get(
						progressKey(entity.id, view.from, lang)
					);
					return {
						lang,
						due: dueOnly
							? isProgressDue(rec, now, schedule)
							: rec?.status !== "mastered" &&
							  !isProgressWaiting(rec, now, schedule),
						progress: rec,
					};
				});
			if (langs.some((l) => l.due)) items.push({ entity, langs });
		}
		if (!items.length) return;
		this.player?.unmount();
		const player = new StudyPlayerPage(
			this.plugin,
			view.name,
			view.from,
			items,
			schedule,
			(rec) => {
				void this.plugin.store.upsertReciteProgress([rec]);
				this.plugin.remindReciteWhenReady(rec);
			},
			() => {
				this.playing = false;
				this.player = null;
				this.needsRender = true;
				void this.reload();
			},
			this.contexts ?? new Map(),
			this.colors
		);
		this.player = player;
		this.playing = true;
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-lex-view");
		player.mount(root.createDiv());
	}

	onKeyDown = (ev: KeyboardEvent): void => {
		if (this.app.workspace.getActiveViewOfType(LexiconView) !== this)
			return;
		const target = ev.target as HTMLElement;
		if (target.closest("input, textarea, [contenteditable]")) return;
		if (ev.key === "Escape" && this.selectMode && !this.playing) {
			this.selectMode = false;
			this.selectedIds.clear();
			this.render();
			ev.preventDefault();
			return;
		}
		if (!this.playing || !this.player) return;
		if (this.player.handleKey(ev)) ev.preventDefault();
	};

	onload(): void {
		super.onload();
		this.registerDomEvent(window, "keydown", this.onKeyDown);
	}
}
