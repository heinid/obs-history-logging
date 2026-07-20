// The entity browse desk: the recitation tab's library page. Filter by
// tags / types / language completeness / search under a chosen front
// language, group and sort, self-test with per-language cloze rows, and
// feed a view's study deck. The whole desk state can be saved as a named
// view (recite-views.md).

import { Notice, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import {
	EntityEntry,
	displayName,
	langRank,
	orderLangs,
} from "./db-format";
import { langDisplayName } from "./quiz-render";
import { NameModal } from "./name-modal";
import { QuizSchedule } from "./quiz";
import { quizDeckStats } from "./deck-stats";
import {
	ReciteView,
	ViewGroup,
	ViewSort,
	entityMatchesView,
	hasLang,
	studyMembers,
} from "./recite-views";
import {
	ReciteProgress,
	isProgressDue,
	progressKey,
	toQuizShape,
} from "./recite-progress";

export interface BrowseState {
	draft: ReciteView;
	// The saved view this desk was opened from; the default target of the
	// study button and of「保存」even after filter tweaks.
	boundView: string | null;
	search: string;
	revealed: Set<string>; // `${entityId}:${lang}` cloze rows opened
	expanded: Set<string>; // entity ids with the other-language fold open
}

export interface BrowseCtx {
	plugin: HistoryLoggingPlugin;
	onBack(): void;
	rerender(): void;
	saveViews(views: ReciteView[]): Promise<void>;
	startLoose(view: ReciteView, entities: EntityEntry[]): void;
	startStudy(view: ReciteView, dueOnly: boolean): void;
}

export function browseStateFromView(view: ReciteView | null): BrowseState {
	return {
		draft: view
			? {
					...view,
					to: [...view.to],
					tags: [...view.tags],
					types: [...view.types],
					members: [...view.members],
			  }
			: {
					name: "",
					from: "",
					to: [],
					tags: [],
					types: [],
					requireFrom: false,
					group: "none",
					sort: "created",
					study: false,
					follow: true,
					members: [],
			  },
		boundView: view?.name ?? null,
		search: "",
		revealed: new Set(),
		expanded: new Set(),
	};
}

function normTag(t: string): string {
	return t.replace(/^#+/, "").trim();
}

function entityStamp(e: EntityEntry): string {
	return e.created ?? e.updated ?? "";
}

function matchesSearch(e: EntityEntry, needle: string): boolean {
	if (!needle) return true;
	const n = needle.toLowerCase();
	return (
		e.id.includes(n) ||
		e.labels.some((l) => l.text.toLowerCase().includes(n)) ||
		e.readings.some((r) => r.text.toLowerCase().includes(n))
	);
}

export function renderBrowseDesk(
	root: HTMLElement,
	state: BrowseState,
	entities: EntityEntry[],
	views: ReciteView[],
	progress: Map<string, ReciteProgress>,
	schedule: QuizSchedule,
	ctx: BrowseCtx
): void {
	const draft = state.draft;
	const langs = ctx.plugin.settings.entityLangs;

	const scoped = entities.filter(
		(e) => entityMatchesView(e, draft) && matchesSearch(e, state.search)
	);
	const visible = scoped.filter(
		(e) => !draft.requireFrom || !draft.from || hasLang(e, draft.from)
	);

	// ── header ──
	const bar = root.createDiv({ cls: "hl-player-top" });
	const back = bar.createEl("button", { cls: "hl-player-back" });
	setIcon(back, "arrow-left");
	back.createSpan({ text: "背诵" });
	back.addEventListener("click", () => ctx.onBack());

	const page = root.createDiv({ cls: "hl-detail-page hl-browse-page" });
	const head = page.createDiv({ cls: "hl-browse-head" });
	head.createDiv({
		cls: "hl-deck-name",
		text: state.boundView ?? "词条浏览台",
	});
	head.createDiv({
		cls: "hl-browse-count",
		text: `${visible.length} 个词条`,
	});
	const headActions = head.createDiv({ cls: "hl-browse-head-actions" });

	// Loose run: the old one-off shuffled pass, no traces.
	const loose = headActions.createEl("button", { text: "随机过一遍" });
	if (visible.length && draft.from && draft.to.length)
		loose.addEventListener("click", () =>
			ctx.startLoose(
				draft,
				visible.filter(
					(e) =>
						hasLang(e, draft.from) &&
						draft.to.some((l) => hasLang(e, l))
				)
			)
		);
	else loose.disabled = true;

	renderStudyControls(headActions, state, entities, views, progress, schedule, ctx);

	// ── filter rows ──
	renderFilters(page, state, entities, scoped, langs, views, ctx);

	// ── cards ──
	if (!visible.length) {
		page.createDiv({
			cls: "hl-deck-empty",
			text: "没有符合筛选的词条。",
		});
		return;
	}
	const groups = groupEntities(visible, draft.group, draft.sort);
	for (const g of groups) {
		if (g.label)
			page.createDiv({
				cls: "hl-overline hl-detail-group-head",
				text: `${g.label} · ${g.items.length}`,
			});
		const wall = page.createDiv({ cls: "hl-browse-wall" });
		for (const e of g.items)
			renderEntityCard(wall, e, state, views, progress, schedule, ctx);
	}
}

// Study stats for a view over member × language keys; directions never
// studied count as fresh active cards (due now).
export function studyStats(
	view: ReciteView,
	entities: Iterable<EntityEntry>,
	progress: Map<string, ReciteProgress>,
	schedule: QuizSchedule,
	now = new Date()
) {
	const members = studyMembers(entities, view);
	const shapes = [];
	let fresh = 0;
	for (const e of members)
		for (const lang of view.to) {
			if (!hasLang(e, lang)) continue;
			const rec = progress.get(progressKey(e.id, view.from, lang));
			if (rec) shapes.push(toQuizShape(rec));
			else fresh++;
		}
	const stats = quizDeckStats(shapes, now, schedule);
	stats.active += fresh;
	stats.due += fresh;
	if (stats.progressDist.length) stats.progressDist[0] += fresh;
	return { stats, members };
}

function renderStudyControls(
	host: HTMLElement,
	state: BrowseState,
	entities: EntityEntry[],
	views: ReciteView[],
	progress: Map<string, ReciteProgress>,
	schedule: QuizSchedule,
	ctx: BrowseCtx
): void {
	const bound = views.find((v) => v.name === state.boundView);
	if (bound?.study) {
		const { stats } = studyStats(bound, entities, progress, schedule);
		const due = host.createEl("button", {
			cls: "mod-cta",
			text: stats.due > 0 ? `背到期 ${stats.due}` : "无到期",
		});
		if (stats.due > 0)
			due.addEventListener("click", () => ctx.startStudy(bound, true));
		else due.disabled = true;
		if (stats.active > 0) {
			const all = host.createEl("button", {
				text: `全部在学 ${stats.active}`,
			});
			all.addEventListener("click", () =>
				ctx.startStudy(bound, false)
			);
		}
		return;
	}
	const study = host.createEl("button", {
		cls: "mod-cta",
		text: "加入学习",
	});
	study.addEventListener("click", () => {
		if (bound) {
			// One click turns the bound view into a study deck following
			// its own filter — the common case, no dialog.
			void ctx.saveViews(
				views.map((v) =>
					v.name === bound.name ? { ...v, study: true } : v
				)
			).then(() => new Notice(`「${bound.name}」已开始学习`));
			return;
		}
		if (!state.draft.from || !state.draft.to.length) {
			new Notice("先选择出发语言和目标语言");
			return;
		}
		new NameModal(ctx.plugin.app, "保存为视图并开始学习", "", (name) => {
			if (views.some((v) => v.name === name)) {
				new Notice("已有同名视图");
				return;
			}
			const view: ReciteView = {
				...state.draft,
				name,
				study: true,
			};
			state.boundView = name;
			void ctx.saveViews([...views, view]).then(() =>
				new Notice(`「${name}」已开始学习`)
			);
		}).open();
	});
}

function renderFilters(
	page: HTMLElement,
	state: BrowseState,
	entities: EntityEntry[],
	scoped: EntityEntry[],
	langs: string[],
	views: ReciteView[],
	ctx: BrowseCtx
): void {
	const draft = state.draft;
	const box = page.createDiv({ cls: "hl-browse-filters" });

	// row 1: languages + grouping/sorting + save
	const row1 = box.createDiv({ cls: "hl-browse-filter-row" });
	const fromSel = row1.createEl("select", { cls: "dropdown" });
	fromSel.setAttr("aria-label", "出发语言");
	fromSel.createEl("option", { value: "", text: "出发语言…" });
	for (const l of langs)
		fromSel.createEl("option", { value: l, text: langDisplayName(l) });
	fromSel.value = draft.from;
	fromSel.addEventListener("change", () => {
		draft.from = fromSel.value;
		ctx.rerender();
	});

	const toWrap = row1.createDiv({ cls: "hl-browse-chiprow" });
	for (const l of langs) {
		if (l === draft.from) continue;
		const on = draft.to.includes(l);
		const chip = toWrap.createEl("button", {
			cls: `hl-browse-chip${on ? " is-on" : ""}`,
			text: langDisplayName(l),
		});
		chip.setAttr("aria-label", `目标语言 ${langDisplayName(l)}`);
		chip.addEventListener("click", () => {
			draft.to = on
				? draft.to.filter((x) => x !== l)
				: [...draft.to, l];
			ctx.rerender();
		});
	}

	const complete = row1.createEl("button", {
		cls: `hl-browse-chip${draft.requireFrom ? " is-on" : ""}`,
		text: "只看有出发语言的",
	});
	complete.addEventListener("click", () => {
		draft.requireFrom = !draft.requireFrom;
		ctx.rerender();
	});

	row1.createDiv({ cls: "hl-browse-spacer" });

	const groupSel = row1.createEl("select", { cls: "dropdown" });
	groupSel.setAttr("aria-label", "分组");
	for (const [v, t] of [
		["none", "不分组"],
		["date", "按日期"],
		["type", "按类型"],
		["tag", "按标签"],
	] as [ViewGroup, string][])
		groupSel.createEl("option", { value: v, text: t });
	groupSel.value = draft.group;
	groupSel.addEventListener("change", () => {
		draft.group = groupSel.value as ViewGroup;
		ctx.rerender();
	});

	const sortSel = row1.createEl("select", { cls: "dropdown" });
	sortSel.setAttr("aria-label", "排序");
	for (const [v, t] of [
		["created", "新加入优先"],
		["updated", "最近更新"],
		["name", "按名称"],
	] as [ViewSort, string][])
		sortSel.createEl("option", { value: v, text: t });
	sortSel.value = draft.sort;
	sortSel.addEventListener("change", () => {
		draft.sort = sortSel.value as ViewSort;
		ctx.rerender();
	});

	const save = row1.createEl("button", {
		cls: "hl-browse-save",
		text: state.boundView ? "保存视图" : "保存为视图",
	});
	save.addEventListener("click", () => {
		if (state.boundView) {
			const name = state.boundView;
			void ctx.saveViews(
				views.map((v) =>
					v.name === name ? { ...draft, name } : v
				)
			).then(() => new Notice(`已保存「${name}」`));
			return;
		}
		new NameModal(ctx.plugin.app, "保存视图", "", (name) => {
			if (views.some((v) => v.name === name)) {
				new Notice("已有同名视图");
				return;
			}
			state.boundView = name;
			void ctx.saveViews([...views, { ...draft, name }]).then(() =>
				new Notice(`已保存「${name}」`)
			);
		}).open();
	});

	// row 2: search
	const row2 = box.createDiv({ cls: "hl-browse-filter-row" });
	const search = row2.createEl("input", {
		cls: "hl-browse-search",
		attr: { type: "search", placeholder: "搜索拼写 / 读音…" },
	});
	search.value = state.search;
	search.addEventListener("input", () => {
		state.search = search.value.trim().toLowerCase();
		ctx.rerender();
	});

	// row 3: type + tag facets, counted within the other filters.
	const facetBase = entities.filter((e) => {
		const probe = { ...draft, tags: [], types: [] };
		return (
			entityMatchesView(e, probe) &&
			matchesSearch(e, state.search)
		);
	});
	const typeCounts = new Map<string, number>();
	const tagCounts = new Map<string, number>();
	for (const e of facetBase) {
		if (e.type)
			typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
		for (const t of e.tags) {
			const k = normTag(t);
			if (k) tagCounts.set(k, (tagCounts.get(k) ?? 0) + 1);
		}
	}
	const row3 = box.createDiv({ cls: "hl-browse-filter-row" });
	for (const [type, count] of [...typeCounts.entries()].sort(
		(a, b) => b[1] - a[1]
	)) {
		const on = draft.types.includes(type);
		const chip = row3.createEl("button", {
			cls: `hl-browse-chip is-type${on ? " is-on" : ""}`,
		});
		chip.createSpan({ text: type });
		chip.createSpan({ cls: "hl-browse-chip-count", text: String(count) });
		chip.addEventListener("click", () => {
			draft.types = on
				? draft.types.filter((x) => x !== type)
				: [...draft.types, type];
			ctx.rerender();
		});
	}
	const row4 = box.createDiv({ cls: "hl-browse-filter-row" });
	for (const [tag, count] of [...tagCounts.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
	)) {
		const on = draft.tags.some((t) => normTag(t) === tag);
		const chip = row4.createEl("button", {
			cls: `hl-browse-chip is-tag${on ? " is-on" : ""}`,
		});
		chip.createSpan({ text: `#${tag}` });
		chip.createSpan({ cls: "hl-browse-chip-count", text: String(count) });
		chip.addEventListener("click", () => {
			draft.tags = on
				? draft.tags.filter((t) => normTag(t) !== tag)
				: [...draft.tags, tag];
			ctx.rerender();
		});
	}
	void scoped;
}

interface Group {
	label: string;
	items: EntityEntry[];
}

function groupEntities(
	items: EntityEntry[],
	group: ViewGroup,
	sort: ViewSort
): Group[] {
	const sorted = [...items].sort((a, b) => {
		if (sort === "name")
			return displayName(a).localeCompare(displayName(b), "zh");
		const sa = entityStamp(a);
		const sb = entityStamp(b);
		if (sort === "updated")
			return (b.updated ?? "").localeCompare(a.updated ?? "");
		return sb.localeCompare(sa);
	});
	if (group === "none") return [{ label: "", items: sorted }];
	const buckets = new Map<string, EntityEntry[]>();
	for (const e of sorted) {
		const keys =
			group === "date"
				? [entityStamp(e).slice(0, 10) || "未记日期"]
				: group === "type"
				? [e.type || "未分类"]
				: e.tags.length
				? e.tags.map(normTag)
				: ["无标签"];
		const key = keys[0];
		const list = buckets.get(key) ?? [];
		list.push(e);
		buckets.set(key, list);
	}
	return [...buckets.entries()]
		.sort((a, b) =>
			group === "date"
				? b[0].localeCompare(a[0])
				: a[0].localeCompare(b[0], "zh")
		)
		.map(([label, list]) => ({ label, items: list }));
}

function renderEntityCard(
	wall: HTMLElement,
	e: EntityEntry,
	state: BrowseState,
	views: ReciteView[],
	progress: Map<string, ReciteProgress>,
	schedule: QuizSchedule,
	ctx: BrowseCtx
): void {
	const draft = state.draft;
	const now = new Date();
	const card = wall.createDiv({ cls: "hl-browse-card" });
	const head = card.createDiv({ cls: "hl-browse-card-head" });
	const front =
		draft.from &&
		e.labels.find((l) => l.lang === draft.from && l.text.trim());
	head.createSpan({
		cls: "hl-browse-front",
		text: front ? front.text : displayName(e),
	});
	if (draft.from && !front)
		head.createSpan({
			cls: "hl-browse-missing",
			text: `缺 ${langDisplayName(draft.from)}`,
		});
	if (e.type) head.createSpan({ cls: "hl-browse-type", text: e.type });
	const bound = views.find((v) => v.name === state.boundView);
	if (bound?.study) renderCardStudyControl(head, e, bound, views, ctx);

	// Cloze rows for the target languages.
	const rows = card.createDiv({ cls: "hl-browse-rows" });
	const targets = orderLangs(
		draft.to.filter((l) => l !== draft.from)
	);
	for (const lang of targets) {
		const label = e.labels.find(
			(l) => l.lang === lang && l.text.trim()
		);
		const row = rows.createDiv({ cls: "hl-browse-row" });
		row.createSpan({
			cls: "hl-recite-lang",
			text: langDisplayName(lang),
		});
		if (!label) {
			row.createSpan({ cls: "hl-browse-missing", text: "缺拼写" });
			continue;
		}
		const key = `${e.id}:${lang}`;
		if (state.revealed.has(key)) {
			const word = row.createSpan({
				cls: "hl-recite-word hl-browse-word",
				text: label.text,
			});
			word.setAttr("aria-label", "再次遮住");
			word.addEventListener("click", () => {
				state.revealed.delete(key);
				ctx.rerender();
			});
			const reading = e.readings.find(
				(r) => r.lang === lang && r.text.trim()
			);
			if (reading)
				row.createSpan({
					cls: "hl-recite-reading",
					text: reading.text,
				});
		} else {
			const mask = row.createEl("button", { cls: "hl-browse-mask" });
			mask.setAttr("aria-label", "揭开");
			mask.addEventListener("click", () => {
				state.revealed.add(key);
				ctx.rerender();
			});
		}
		if (bound?.study && draft.from) {
			const rec = progress.get(progressKey(e.id, draft.from, lang));
			const steps = Math.max(1, schedule.masterySteps);
			const p =
				rec?.status === "mastered"
					? steps
					: rec?.progress ?? 0;
			const dots = row.createSpan({
				cls: `hl-study-dots${
					isProgressDue(rec, now, schedule) ? " is-due" : ""
				}`,
				text:
					"●".repeat(Math.min(p, steps)) +
					"○".repeat(steps - Math.min(p, steps)),
			});
			dots.setAttr(
				"aria-label",
				rec?.status === "mastered" ? "已学过" : `掌握 ${p}/${steps}`
			);
		}
	}

	// Languages outside the direction fold away, reference only.
	const others = orderLangs(
		[...new Set(e.labels.map((l) => l.lang))].filter(
			(l) => l !== draft.from && !targets.includes(l)
		)
	).sort((a, b) => langRank(a) - langRank(b));
	if (others.length) {
		if (state.expanded.has(e.id)) {
			const fold = card.createDiv({ cls: "hl-browse-others" });
			for (const lang of others) {
				const label = e.labels.find(
					(l) => l.lang === lang && l.text.trim()
				);
				if (!label) continue;
				const row = fold.createDiv({ cls: "hl-browse-row is-other" });
				row.createSpan({
					cls: "hl-recite-lang",
					text: langDisplayName(lang),
				});
				row.createSpan({
					cls: "hl-recite-word",
					text: label.text,
				});
			}
		} else {
			const more = card.createEl("button", {
				cls: "hl-browse-more",
				text: `其它语言 +${others.length}`,
			});
			more.addEventListener("click", () => {
				state.expanded.add(e.id);
				ctx.rerender();
			});
		}
	}
}

// Membership toggle on a card when the desk is bound to a study view: quick
// add under a tweaked filter, remove for explicit members.
function renderCardStudyControl(
	head: HTMLElement,
	e: EntityEntry,
	bound: ReciteView,
	views: ReciteView[],
	ctx: BrowseCtx
): void {
	const inFilter = bound.follow && entityMatchesView(e, bound);
	const isMember = inFilter || bound.members.includes(e.id);
	if (isMember && inFilter) return; // implicit member, nothing to toggle
	const btn = head.createEl("button", { cls: "hl-browse-member" });
	setIcon(btn, isMember ? "check" : "plus");
	btn.setAttr(
		"aria-label",
		isMember ? "移出学习（进度保留）" : `加入「${bound.name}」学习`
	);
	btn.addEventListener("click", () => {
		const members = isMember
			? bound.members.filter((id) => id !== e.id)
			: [...bound.members, e.id];
		void ctx.saveViews(
			views.map((v) =>
				v.name === bound.name ? { ...v, members } : v
			)
		).then(() =>
			new Notice(
				isMember
					? "已移出学习（进度保留）"
					: `已加入「${bound.name}」`
			)
		);
	});
}
