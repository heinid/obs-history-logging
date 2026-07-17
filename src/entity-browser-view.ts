import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName } from "./db-format";
import { entitySearchText, parseDbMarks, stripDbMarkers } from "./db-marker";
import { entityHint } from "./live-editor";
import { EntityModal } from "./entity-modal";
import { generateId } from "./id";
import { ConfirmModal } from "./name-modal";
import { renderEntityPage } from "./entity-page";
import { describeYear, parseYearTag } from "./year-tag";
import { QuizEntry } from "./quiz";
import {
	QuizBackstageStatus,
	renderQuizBackstage,
} from "./quiz-backstage";
import { EventEntry } from "./types";

export const ENTITY_BROWSER_VIEW_TYPE = "history-logging-entity-browser";

// One event summary an entity is annotated in.
interface OccHit {
	evId: string;
	tag: string;
	snippet: string;
	key: number;
}

interface Row {
	entity: EntityEntry;
	occ: OccHit[];
}

type SortKey = "occ" | "name" | "file";
type HealthKey = "all" | "unused" | "no-notes";

// Tag filter sentinel: the empty string stands for "entries with no tags".
const NO_TAG = "";

// Browser-style navigation stack: every place you can be in the backstage is
// a frame; back/forward restores it including scroll position and filters.
type NavFrame =
	| {
			kind: "entities";
			query: string;
			types: string[];
			tags: string[];
			sort: SortKey;
			health: HealthKey;
			scroll: number;
	  }
	| { kind: "types"; scroll: number }
	| {
			kind: "quizzes";
			query: string;
			status: QuizBackstageStatus;
			scroll: number;
	  }
	| { kind: "entity"; id: string; scroll: number };

const ROW_H = 32;
const OVERSCAN = 8;

// The plugin backstage: entity catalogue and type manager as sections of one
// tab, with wiki-style in-place navigation into entity pages.
export class EntityBrowserView extends ItemView {
	private rows: Row[] = [];
	private filtered: Row[] = [];
	private types: DbType[] = [];
	private quizzes: QuizEntry[] = [];
	private events = new Map<string, EventEntry>();
	private query = "";
	private selectedTypes = new Set<string>();
	private selectedTags = new Set<string>();
	private tagQuery = "";
	private sort: SortKey = "occ";
	private health: HealthKey = "all";
	private stack: NavFrame[] = [
		{
			kind: "entities",
			query: "",
			types: [],
			tags: [],
			sort: "occ",
			health: "all",
			scroll: 0,
		},
	];
	private pos = 0;
	private bodyEl?: HTMLElement;
	private navBack?: HTMLButtonElement;
	private navFwd?: HTMLButtonElement;
	private tabEls = new Map<string, HTMLElement>();
	private countEl?: HTMLElement;
	private scrollEl?: HTMLElement;
	private spacerEl?: HTMLElement;
	private tagBarEl?: HTMLElement;
	private tagMenuBtn?: HTMLButtonElement;
	private reloadTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ENTITY_BROWSER_VIEW_TYPE;
	}

	getDisplayText(): string {
		const top = this.stack[this.pos];
		if (top?.kind === "entity") {
			const row = this.rows.find((r) => r.entity.id === top.id);
			if (row) return displayName(row.entity);
		}
		return "History Logging";
	}

	getIcon(): string {
		return "library";
	}

	async onOpen(): Promise<void> {
		// The catalogue lives in a few data files; a debounced reload on any
		// of them keeps the backstage current without rescanning per edit.
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				const folder = this.plugin.settings.dataFolder.replace(/\/+$/, "");
				if (
					f.path === `${folder}/entities.md` ||
					f.path === `${folder}/events.md` ||
					f.path === `${folder}/db-types.md` ||
					f.path === `${folder}/quizzes.md`
				)
					this.scheduleReload();
			})
		);
		await this.reload();
	}

	onClose(): Promise<void> {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		return Promise.resolve();
	}

	private scheduleReload(): void {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			void this.reload();
		}, 400);
	}

	async reload(): Promise<void> {
		const [entities, events, types, quizzes] = await Promise.all([
			this.plugin.store.readEntities(),
			this.plugin.store.readEvents(),
			this.plugin.store.readDbTypes(),
			this.plugin.store.readQuizzes(),
		]);
		this.types = types;
		this.events = events;
		this.quizzes = [...quizzes.values()];
		const colorOf = new Map(types.map((t) => [t.name, t.color]));
		this.dbColors = new Map(
			[...entities.values()].map((e) => [e.id, colorOf.get(e.type) ?? ""])
		);
		const occ = new Map<string, OccHit[]>();
		for (const [evId, ev] of events) {
			const ids = new Set(parseDbMarks(ev.summary).map((m) => m.id));
			if (!ids.size) continue;
			const key = ev.tag ? parseYearTag(ev.tag)?.sortKey ?? 0 : 0;
			const snippet = stripDbMarkers(ev.summary)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 80);
			for (const id of ids) {
				const list = occ.get(id) ?? [];
				list.push({ evId, tag: ev.tag ?? "", snippet, key });
				occ.set(id, list);
			}
		}
		this.rows = [...entities.values()].map((entity) => ({
			entity,
			occ: (occ.get(entity.id) ?? []).sort((a, b) => a.key - b.key),
		}));
		this.snapshot();
		this.render();
	}

	private dbColors = new Map<string, string>();

	private typeColor(name: string): string | null {
		return this.types.find((t) => t.name === name)?.color ?? null;
	}

	// --- navigation stack -------------------------------------------------

	private current(): NavFrame {
		return this.stack[this.pos];
	}

	// Snapshot the live UI state into the current frame before leaving it.
	private snapshot(): void {
		const f = this.current();
		const scroll = this.bodyScroll();
		if (f.kind === "entities") {
			f.query = this.query;
			f.types = [...this.selectedTypes];
			f.tags = [...this.selectedTags];
			f.sort = this.sort;
			f.health = this.health;
			f.scroll = scroll;
		} else f.scroll = scroll;
	}

	// Async markdown rendering grows the list after the rebuild, so a single
	// immediate scrollTop gets clamped near the top. Keep re-applying the
	// target until the content is tall enough (or a short deadline passes).
	private restoreBodyScroll(el: HTMLElement, target: number): void {
		if (target <= 0) return;
		el.scrollTop = target;
		const until = Date.now() + 1500;
		const tick = (): void => {
			el.scrollTop = target;
			if (Math.abs(el.scrollTop - target) < 1 || Date.now() > until)
				return;
			window.requestAnimationFrame(tick);
		};
		window.requestAnimationFrame(tick);
	}

	private bodyScroll(): number {
		const kind = this.current().kind;
		if (kind === "entities") return this.scrollEl?.scrollTop ?? 0;
		if (kind === "quizzes") return this.quizScrollEl()?.scrollTop ?? 0;
		return this.bodyEl?.scrollTop ?? 0;
	}

	// The quiz backstage scrolls in its own inner list, not in the body.
	private quizScrollEl(): HTMLElement | null {
		return (
			this.bodyEl?.querySelector<HTMLElement>(".hl-quiz-backstage-list") ??
			null
		);
	}

	private push(frame: NavFrame): void {
		this.snapshot();
		this.stack.splice(this.pos + 1);
		this.stack.push(frame);
		this.pos = this.stack.length - 1;
		this.render();
	}

	// Section switches don't take part in back/forward history — the arrows
	// only walk entity-page navigation. Replace the current frame instead.
	private replace(frame: NavFrame): void {
		this.stack[this.pos] = frame;
		this.render();
	}

	private go(delta: number): void {
		const next = this.pos + delta;
		if (next < 0 || next >= this.stack.length) return;
		this.snapshot();
		this.pos = next;
		this.render();
	}

	// --- chrome -------------------------------------------------------------

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-entity-browser");

		const nav = root.createDiv({ cls: "hl-eb-nav" });
		this.navBack = nav.createEl("button", { cls: "hl-icon-btn" });
		setIcon(this.navBack, "arrow-left");
		this.navBack.setAttr("aria-label", "后退");
		this.navBack.disabled = this.pos === 0;
		this.navBack.addEventListener("click", () => this.go(-1));
		this.navFwd = nav.createEl("button", { cls: "hl-icon-btn" });
		setIcon(this.navFwd, "arrow-right");
		this.navFwd.setAttr("aria-label", "前进");
		this.navFwd.disabled = this.pos >= this.stack.length - 1;
		this.navFwd.addEventListener("click", () => this.go(1));

		const tabs = nav.createDiv({ cls: "hl-eb-tabs" });
		this.tabEls.clear();
		const mkTab = (
			key: "entities" | "types" | "quizzes",
			label: string
		): void => {
			const el = tabs.createSpan({ cls: "hl-eb-tab", text: label });
			this.tabEls.set(key, el);
			el.addEventListener("click", () => {
				if (this.current().kind === key) return;
				if (key === "entities")
					this.replace({
						kind: "entities",
						query: this.query,
						types: [...this.selectedTypes],
						tags: [...this.selectedTags],
						sort: this.sort,
						health: this.health,
						scroll: 0,
					});
				else if (key === "types")
					this.replace({ kind: "types", scroll: 0 });
				else
					this.replace({
						kind: "quizzes",
						query: "",
						status: "active",
						scroll: 0,
					});
			});
		};
		mkTab("entities", "词条");
		mkTab("types", "范畴");
		mkTab("quizzes", "Quiz");
		const cur = this.current();
		const activeTab =
			cur.kind === "types"
				? "types"
				: cur.kind === "quizzes"
				? "quizzes"
				: "entities";
		this.tabEls.get(activeTab)?.addClass("is-active");
		if (cur.kind === "entity") {
			const crumb = nav.createSpan({ cls: "hl-eb-crumb" });
			const row = this.rows.find((r) => r.entity.id === cur.id);
			crumb.setText(`› ${row ? displayName(row.entity) : cur.id}`);
		}

		this.bodyEl = root.createDiv({ cls: "hl-eb-body" });
		if (cur.kind === "entities") this.renderEntities(this.bodyEl, cur);
		else if (cur.kind === "types") this.renderTypes(this.bodyEl, cur);
		else if (cur.kind === "quizzes") {
			renderQuizBackstage(
				this.bodyEl,
				this.plugin,
				this.quizzes,
				this.events,
				this.dbColors,
				cur,
				() => this.reload()
			);
			const scroller = this.quizScrollEl();
			if (scroller) this.restoreBodyScroll(scroller, cur.scroll);
		}
		else void this.renderEntity(this.bodyEl, cur);
		// Refresh the tab title (Obsidian re-reads getDisplayText on layout
		// change; trigger it via the leaf's internal header update if present).
		(
			this.leaf as unknown as { updateHeader?: () => void }
		).updateHeader?.();
	}

	// --- entities section -----------------------------------------------

	private renderEntities(
		host: HTMLElement,
		frame: Extract<NavFrame, { kind: "entities" }>
	): void {
		this.query = frame.query;
		this.selectedTypes = new Set(frame.types);
		this.selectedTags = new Set(frame.tags);
		this.sort = frame.sort;
		this.health = frame.health;

		const split = host.createDiv({ cls: "hl-eb-split" });
		this.tagBarEl = split.createDiv({ cls: "hl-eb-tagbar" });
		const main = split.createDiv({ cls: "hl-eb-main" });
		// The tag sidebar needs real width; in a narrow pane it folds into a
		// dropdown button in the toolbar instead.
		const ro = new ResizeObserver(() =>
			split.toggleClass("is-narrow", split.clientWidth < 560)
		);
		ro.observe(split);
		this.register(() => ro.disconnect());

		const bar = main.createDiv({ cls: "hl-eb-bar" });

		this.tagMenuBtn = bar.createEl("button", {
			cls: "hl-modal-foot-btn hl-eb-tag-menu-btn",
		});
		this.paintTagMenuBtn();
		this.tagMenuBtn.addEventListener("click", (e) =>
			this.openTagMenu(e)
		);

		const search = bar.createEl("input", {
			cls: "hl-eb-search",
			type: "search",
			placeholder: "搜索词条…",
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.refreshList();
		});

		const sortSel = bar.createEl("select", { cls: "dropdown hl-eb-select" });
		for (const [v, label] of [
			["occ", "按出现次数"],
			["name", "按名称"],
			["file", "按文件顺序"],
		] as [SortKey, string][])
			sortSel.createEl("option", { value: v, text: label });
		sortSel.value = this.sort;
		sortSel.addEventListener("change", () => {
			this.sort = sortSel.value as SortKey;
			this.refreshList();
		});

		const healthSel = bar.createEl("select", {
			cls: "dropdown hl-eb-select",
		});
		for (const [v, label] of [
			["all", "全部"],
			["unused", "未使用"],
			["no-notes", "缺 notes"],
		] as [HealthKey, string][])
			healthSel.createEl("option", { value: v, text: label });
		healthSel.value = this.health;
		healthSel.addEventListener("change", () => {
			this.health = healthSel.value as HealthKey;
			this.refreshList();
		});

		const refresh = bar.createEl("button", { cls: "hl-icon-btn" });
		setIcon(refresh, "refresh-cw");
		refresh.setAttr("aria-label", "刷新");
		refresh.addEventListener("click", () => void this.reload());

		const add = bar.createEl("button", {
			cls: "hl-modal-foot-btn hl-eb-add",
			text: "＋ 新建词条",
		});
		add.addEventListener("click", () => this.createEntity());

		this.countEl = main.createDiv({ cls: "hl-eb-count" });

		this.scrollEl = main.createDiv({ cls: "hl-eb-list" });
		this.spacerEl = this.scrollEl.createDiv({ cls: "hl-eb-spacer" });
		this.registerDomEvent(this.scrollEl, "scroll", () =>
			this.renderWindow()
		);
		this.refreshList();
		this.scrollEl.scrollTop = frame.scroll;
	}

	private refreshList(): void {
		this.applyFilters();
		if (this.countEl)
			this.countEl.setText(
				`共 ${this.rows.length} 条 · 筛出 ${this.filtered.length} 条`
			);
		if (this.spacerEl) {
			this.spacerEl.empty();
			this.spacerEl.style.height = `${this.filtered.length * ROW_H}px`;
		}
		this.renderWindow(true);
		this.renderTagBar();
		this.paintTagMenuBtn();
	}

	// --- filter sidebar ---------------------------------------------------

	// Entries that pass everything except the tag selection: the base set the
	// tag counts are computed against, so counts narrow along with search /
	// type / health filters (Zotero-style co-occurrence).
	private tagFilterBase(): Row[] {
		return this.rows.filter((r) => this.passesNonTagFilters(r));
	}

	// Same idea for the type section: everything except the type selection.
	private typeFilterBase(): Row[] {
		return this.rows.filter(
			(r) => this.passesFiltersIgnoringTypes(r) && this.matchesTags(r)
		);
	}

	private toggleType(name: string): void {
		if (this.selectedTypes.has(name)) this.selectedTypes.delete(name);
		else this.selectedTypes.add(name);
		this.refreshList();
	}

	private matchesTags(r: Row): boolean {
		for (const t of this.selectedTags) {
			if (t === NO_TAG) {
				if (r.entity.tags.length) return false;
			} else if (!r.entity.tags.includes(t)) return false;
		}
		return true;
	}

	private toggleTag(tag: string): void {
		if (this.selectedTags.has(tag)) this.selectedTags.delete(tag);
		else {
			// 「无标签」和具体 tag 互斥：交集必然为空。
			if (tag === NO_TAG) this.selectedTags.clear();
			else this.selectedTags.delete(NO_TAG);
			this.selectedTags.add(tag);
		}
		this.refreshList();
	}

	private renderTagBar(): void {
		const host = this.tagBarEl;
		if (!host) return;
		host.empty();

		// 范畴 section: single-valued attribute, multi-select = union. Fixed
		// max height with its own scrollbar so a long type list never squeezes
		// the tag section out.
		host.createDiv({ cls: "hl-eb-side-head", text: "范畴" });
		const typeList = host.createDiv({ cls: "hl-eb-type-filter-list" });
		const typeBase = this.typeFilterBase();
		const typeCounts = new Map<string, number>();
		for (const r of typeBase)
			typeCounts.set(
				r.entity.type,
				(typeCounts.get(r.entity.type) ?? 0) + 1
			);
		for (const t of this.types) {
			const n = typeCounts.get(t.name) ?? 0;
			const active = this.selectedTypes.has(t.name);
			const item = typeList.createDiv({
				cls: `hl-eb-tag-item${active ? " is-active" : ""}${
					n || active ? "" : " is-dim"
				}`,
			});
			const dot = item.createSpan({ cls: "hl-eb-type-dot" });
			dot.style.backgroundColor = t.color;
			item.createSpan({ cls: "hl-eb-tag-name", text: t.name });
			item.createSpan({ cls: "hl-eb-tag-count", text: String(n) });
			item.addEventListener("click", () => this.toggleType(t.name));
		}

		host.createDiv({ cls: "hl-eb-side-head", text: "标签" });
		const search = host.createEl("input", {
			cls: "hl-eb-tag-search",
			type: "search",
			placeholder: "筛选标签…",
		});
		search.value = this.tagQuery;
		search.addEventListener("input", () => {
			this.tagQuery = search.value;
			this.renderTagBar();
			const el = this.tagBarEl?.querySelector<HTMLInputElement>(
				".hl-eb-tag-search"
			);
			el?.focus();
			el?.setSelectionRange(el.value.length, el.value.length);
		});

		const list = host.createDiv({ cls: "hl-eb-tag-list" });
		const base = this.tagFilterBase();
		const withSel = base.filter((r) => this.matchesTags(r));

		const mkItem = (
			label: string,
			count: number,
			opts: { tag?: string; fixed?: boolean } = {}
		): void => {
			const { tag, fixed } = opts;
			const active =
				tag === undefined
					? this.selectedTags.size === 0
					: this.selectedTags.has(tag);
			const item = list.createDiv({
				cls: `hl-eb-tag-item${active ? " is-active" : ""}${
					fixed ? " is-fixed" : ""
				}${count || active ? "" : " is-dim"}`,
			});
			item.createSpan({ cls: "hl-eb-tag-name", text: label });
			item.createSpan({ cls: "hl-eb-tag-count", text: String(count) });
			item.addEventListener("click", () => {
				if (tag === undefined) {
					if (!this.selectedTags.size) return;
					this.selectedTags.clear();
					this.refreshList();
				} else this.toggleTag(tag);
			});
		};

		mkItem("全部", base.length);
		mkItem(
			"无标签",
			withSel.filter((r) => !r.entity.tags.length).length,
			{ tag: NO_TAG, fixed: true }
		);

		const counts = new Map<string, number>();
		for (const r of withSel)
			for (const t of r.entity.tags)
				counts.set(t, (counts.get(t) ?? 0) + 1);
		// Selected tags stay listed even when the narrowed count hits zero.
		for (const t of this.selectedTags)
			if (t !== NO_TAG && !counts.has(t)) counts.set(t, 0);
		// Unselected tags absent from the current result set still show,
		// dimmed, so the full vocabulary stays surveyable.
		for (const r of base)
			for (const t of r.entity.tags)
				if (!counts.has(t)) counts.set(t, 0);

		const q = this.tagQuery.trim().toLowerCase();
		const tags = [...counts.entries()]
			.filter(([t]) => !q || t.toLowerCase().includes(q))
			.sort(
				(a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
			);
		for (const [t, n] of tags) mkItem(t, n, { tag: t });
		if (!tags.length)
			list.createDiv({
				cls: "hl-eb-tag-empty",
				text: q ? "没有匹配的标签。" : "还没有标签。",
			});
	}

	private paintTagMenuBtn(): void {
		const btn = this.tagMenuBtn;
		if (!btn) return;
		const n = this.selectedTags.size + this.selectedTypes.size;
		btn.setText(n ? `筛选 · ${n} ▾` : "筛选 ▾");
		btn.toggleClass("is-active", n > 0);
	}

	// Narrow-pane fallback: the sidebar's content as a checkable menu.
	private openTagMenu(e: MouseEvent): void {
		const menu = new Menu();
		const typeBase = this.typeFilterBase();
		const typeCounts = new Map<string, number>();
		for (const r of typeBase)
			typeCounts.set(
				r.entity.type,
				(typeCounts.get(r.entity.type) ?? 0) + 1
			);
		for (const t of this.types)
			menu.addItem((item) =>
				item
					.setTitle(`${t.name}（${typeCounts.get(t.name) ?? 0}）`)
					.setChecked(this.selectedTypes.has(t.name))
					.onClick(() => this.toggleType(t.name))
			);
		menu.addSeparator();
		const base = this.tagFilterBase();
		const withSel = base.filter((r) => this.matchesTags(r));
		menu.addItem((item) =>
			item
				.setTitle(`全部（${base.length}）`)
				.setChecked(this.selectedTags.size === 0)
				.onClick(() => {
					this.selectedTags.clear();
					this.refreshList();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle(
					`无标签（${withSel.filter((r) => !r.entity.tags.length).length}）`
				)
				.setChecked(this.selectedTags.has(NO_TAG))
				.onClick(() => this.toggleTag(NO_TAG))
		);
		menu.addSeparator();
		const counts = new Map<string, number>();
		for (const r of withSel)
			for (const t of r.entity.tags)
				counts.set(t, (counts.get(t) ?? 0) + 1);
		for (const t of this.selectedTags)
			if (t !== NO_TAG && !counts.has(t)) counts.set(t, 0);
		for (const r of base)
			for (const t of r.entity.tags)
				if (!counts.has(t)) counts.set(t, 0);
		const tags = [...counts.entries()].sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
		);
		for (const [t, n] of tags)
			menu.addItem((item) =>
				item
					.setTitle(`${t}（${n}）`)
					.setChecked(this.selectedTags.has(t))
					.onClick(() => this.toggleTag(t))
			);
		menu.showAtMouseEvent(e);
	}

	private passesNonTagFilters(r: Row): boolean {
		if (this.selectedTypes.size && !this.selectedTypes.has(r.entity.type))
			return false;
		return this.passesFiltersIgnoringTypes(r);
	}

	private passesFiltersIgnoringTypes(r: Row): boolean {
		const q = this.query.trim().toLowerCase();
		if (this.health === "unused" && r.occ.length) return false;
		if (this.health === "no-notes" && r.entity.body.trim()) return false;
		if (!q) return true;
		return (
			entitySearchText(r.entity).toLowerCase().includes(q) ||
			r.entity.body.toLowerCase().includes(q)
		);
	}

	private applyFilters(): void {
		this.filtered = this.rows.filter(
			(r) => this.passesNonTagFilters(r) && this.matchesTags(r)
		);
		const name = (r: Row): string => displayName(r.entity);
		if (this.sort === "occ")
			this.filtered.sort(
				(a, b) =>
					b.occ.length - a.occ.length ||
					name(a).localeCompare(name(b))
			);
		else if (this.sort === "name")
			this.filtered.sort((a, b) => name(a).localeCompare(name(b)));
		// "file": keep entities.md order (Map preserves insertion order).
	}

	// Virtualised window: only the rows in (and just around) the viewport
	// exist in the DOM, so tens of thousands of entries scroll smoothly.
	private renderWindow(reset = false): void {
		const scroll = this.scrollEl;
		const spacer = this.spacerEl;
		if (!scroll || !spacer) return;
		if (reset) spacer.empty();
		const first = Math.max(
			0,
			Math.floor(scroll.scrollTop / ROW_H) - OVERSCAN
		);
		const last = Math.min(
			this.filtered.length,
			Math.ceil((scroll.scrollTop + scroll.clientHeight) / ROW_H) +
				OVERSCAN
		);
		const want = new Set<number>();
		for (let i = first; i < last; i++) want.add(i);
		const have = new Set<number>();
		for (const el of Array.from(
			spacer.querySelectorAll<HTMLElement>(".hl-eb-row")
		)) {
			const i = Number(el.dataset.index);
			if (want.has(i)) have.add(i);
			else el.remove();
		}
		for (const i of want) {
			if (have.has(i)) continue;
			spacer.appendChild(this.buildRow(this.filtered[i], i));
		}
		if (!this.filtered.length && !spacer.querySelector(".hl-eb-empty"))
			spacer.createDiv({
				cls: "hl-eb-empty",
				text: this.rows.length
					? "没有词条符合当前筛选。"
					: "还没有词条。在事件总结里选中文字右键即可创建。",
			});
	}

	private buildRow(row: Row, index: number): HTMLElement {
		const el = createDiv({ cls: "hl-eb-row" });
		el.dataset.index = String(index);
		el.style.top = `${index * ROW_H}px`;
		el.style.height = `${ROW_H}px`;

		el.createSpan({ cls: "hl-eb-name", text: displayName(row.entity) });
		const typeCell = el.createSpan({ cls: "hl-eb-row-type" });
		const dot = typeCell.createSpan({ cls: "hl-eb-type-dot" });
		const color = this.typeColor(row.entity.type);
		if (color) dot.style.backgroundColor = color;
		typeCell.createSpan({
			cls: "hl-eb-row-type-name",
			text: row.entity.type || "?",
		});
		const tagsCell = el.createSpan({ cls: "hl-eb-row-tags" });
		for (const t of row.entity.tags)
			tagsCell.createSpan({ cls: "hl-eb-row-tag", text: t });
		const hint = entityHint(row.entity, displayName(row.entity));
		el.createSpan({ cls: "hl-eb-hint", text: hint ?? "" });

		const occCell = el.createSpan({ cls: "hl-eb-row-occ" });
		if (row.occ.length) {
			const badge = occCell.createSpan({
				cls: "hl-eb-badge",
				text: `×${row.occ.length}`,
			});
			badge.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openOccMenu(e, row);
			});
		}

		// Left click navigates in place; middle / Ctrl-click opens the
		// standalone tab, like a browser's "open in new tab".
		el.addEventListener("click", (e) => {
			if (e.ctrlKey || e.metaKey)
				void this.plugin.openEntityView(row.entity.id);
			else this.openEntityInPlace(row.entity.id);
		});
		el.addEventListener("auxclick", (e) => {
			if (e.button === 1) void this.plugin.openEntityView(row.entity.id);
		});
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.openRowMenu(e, row);
		});
		return el;
	}

	private openEntityInPlace(id: string): void {
		this.push({ kind: "entity", id, scroll: 0 });
	}

	// The usage badge unfolds into the entity's occurrences: pick one to jump
	// straight into its summary editor.
	private openOccMenu(e: MouseEvent, row: Row): void {
		const menu = new Menu();
		const cap = 12;
		for (const hit of row.occ.slice(0, cap)) {
			const decoded = hit.tag ? parseYearTag(hit.tag) : null;
			const year = decoded ? describeYear(decoded) : hit.tag;
			menu.addItem((item) =>
				item
					.setTitle(`${year} — ${hit.snippet}`)
					.setIcon("calendar")
					.onClick(() =>
						this.plugin.openSummary(hit.evId, hit.tag, () =>
							void this.reload()
						)
					)
			);
		}
		if (row.occ.length > cap)
			menu.addItem((item) =>
				item
					.setTitle(`… 共 ${row.occ.length} 处，打开词条页查看全部`)
					.setIcon("book-open")
					.onClick(() => this.openEntityInPlace(row.entity.id))
			);
		menu.showAtMouseEvent(e);
	}

	private openRowMenu(e: MouseEvent, row: Row): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("编辑词条")
				.setIcon("pencil")
				.onClick(() => {
					new EntityModal(this.app, this.plugin, row.entity, false, () =>
						void this.reload()
					).open();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("在新页签打开词条页")
				.setIcon("book-open")
				.onClick(() => void this.plugin.openEntityView(row.entity.id))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("删除词条")
				.setIcon("trash")
				.onClick(() => void this.deleteEntity(row))
		);
		menu.showAtMouseEvent(e);
	}

	private deleteEntity(row: Row): void {
		const n = row.occ.length;
		new ConfirmModal(
			this.app,
			"删除词条",
			n
				? `确定删除「${displayName(row.entity)}」？正文中 ${n} 处标注会保留但将失效。`
				: `确定删除「${displayName(row.entity)}」？`,
			"删除",
			() =>
				void (async () => {
					await this.plugin.store.removeEntity(row.entity.id);
					new Notice(`已删除词条「${displayName(row.entity)}」。`);
					await this.reload();
				})()
		).open();
	}

	private createEntity(): void {
		const entity: EntityEntry = {
			id: generateId((id) => this.rows.some((r) => r.entity.id === id)),
			type: "",
			labels: [
				{
					lang: this.plugin.settings.entityLangs[0] ?? "zh",
					text: "",
				},
			],
			readings: [],
			audios: [],
			tags: [],
			body: "",
		};
		new EntityModal(this.app, this.plugin, entity, true, () =>
			void this.reload()
		).open();
	}

	// --- entity page (in-place) -------------------------------------------

	private async renderEntity(
		host: HTMLElement,
		frame: Extract<NavFrame, { kind: "entity" }>
	): Promise<void> {
		const page = host.createDiv({ cls: "hl-eb-entity-host" });
		await renderEntityPage(page, frame.id, {
			plugin: this.plugin,
			component: this,
			refresh: () => void this.reload(),
		});
		host.scrollTop = frame.scroll;
	}

	// --- types section ----------------------------------------------------

	private typeCount(name: string): number {
		return this.rows.filter((r) => r.entity.type === name).length;
	}

	private renderTypes(
		host: HTMLElement,
		frame: Extract<NavFrame, { kind: "types" }>
	): void {
		const wrap = host.createDiv({ cls: "hl-eb-types" });
		wrap.createDiv({
			cls: "hl-eb-count",
			text: "改名会自动更新所有词条；删除非空范畴需先选择词条的去处。",
		});
		const list = wrap.createDiv({ cls: "hl-eb-type-list" });
		this.types.forEach((t, i) => this.buildTypeRow(list, t, i));

		const unknown = this.rows.filter(
			(r) => !this.types.some((t) => t.name === r.entity.type)
		).length;
		if (unknown)
			wrap.createDiv({
				cls: "hl-eb-type-warn",
				text: `⚠ ${unknown} 个词条的范畴不在此列表中（未知范畴）。`,
			});

		const add = wrap.createEl("button", {
			cls: "hl-modal-foot-btn hl-eb-add",
			text: "＋ 新建范畴",
		});
		add.addEventListener("click", async () => {
			const name = this.freshTypeName();
			await this.plugin.store.writeDbTypes([
				...this.types,
				{ name, color: "#888888" },
			]);
			await this.reload();
		});
		host.scrollTop = frame.scroll;
	}

	private freshTypeName(): string {
		let n = 1;
		while (this.types.some((t) => t.name === `type-${n}`)) n++;
		return `type-${n}`;
	}

	private buildTypeRow(list: HTMLElement, t: DbType, index: number): void {
		const row = list.createDiv({ cls: "hl-eb-type-row" });

		const swatch = row.createEl("input", {
			cls: "hl-eb-type-color",
			type: "color",
		});
		swatch.value = /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : "#888888";
		swatch.addEventListener("change", async () => {
			const next = this.types.map((x) =>
				x.name === t.name ? { ...x, color: swatch.value } : x
			);
			await this.plugin.store.writeDbTypes(next);
			await this.reload();
		});

		const name = row.createEl("input", {
			cls: "hl-eb-type-name",
			type: "text",
		});
		name.value = t.name;
		const commit = async (): Promise<void> => {
			const to = name.value.trim();
			if (!to || to === t.name) {
				name.value = t.name;
				return;
			}
			if (this.types.some((x) => x.name === to)) {
				new Notice(`范畴「${to}」已存在。如需合并请用右键菜单。`);
				name.value = t.name;
				return;
			}
			await this.renameType(t.name, to);
		};
		name.addEventListener("blur", () => void commit());
		name.addEventListener("keydown", (e) => {
			if (e.key === "Enter") name.blur();
			if (e.key === "Escape") {
				name.value = t.name;
				name.blur();
			}
		});

		const count = this.typeCount(t.name);
		const badge = row.createSpan({
			cls: `hl-eb-badge${count ? "" : " is-zero"}`,
			text: count ? `${count} 词条` : "空",
		});
		if (count)
			badge.addEventListener("click", () =>
				this.replace({
					kind: "entities",
					query: "",
					types: [t.name],
					tags: [],
					sort: this.sort,
					health: "all",
					scroll: 0,
				})
			);

		const up = row.createEl("button", { cls: "hl-icon-btn" });
		setIcon(up, "chevron-up");
		up.disabled = index === 0;
		up.addEventListener("click", () => void this.moveType(index, -1));
		const down = row.createEl("button", { cls: "hl-icon-btn" });
		setIcon(down, "chevron-down");
		down.disabled = index === this.types.length - 1;
		down.addEventListener("click", () => void this.moveType(index, 1));

		const more = row.createEl("button", { cls: "hl-icon-btn" });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (e) => {
			const menu = new Menu();
			for (const other of this.types) {
				if (other.name === t.name) continue;
				menu.addItem((item) =>
					item
						.setTitle(`合并到「${other.name}」`)
						.setIcon("merge")
						.onClick(() => void this.mergeType(t.name, other.name))
				);
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("删除范畴")
					.setIcon("trash")
					.onClick(() => this.deleteType(t, e))
			);
			menu.showAtMouseEvent(e as MouseEvent);
		});
	}

	private async moveType(index: number, delta: number): Promise<void> {
		const next = [...this.types];
		const j = index + delta;
		if (j < 0 || j >= next.length) return;
		[next[index], next[j]] = [next[j], next[index]];
		await this.plugin.store.writeDbTypes(next);
		await this.reload();
	}

	// Renaming a type is only safe if every entity that references it is
	// rewritten in the same operation.
	private async renameType(from: string, to: string): Promise<void> {
		const entities = await this.plugin.store.readEntities();
		let n = 0;
		for (const e of entities.values())
			if (e.type === from) {
				e.type = to;
				n++;
			}
		if (n) await this.plugin.store.writeEntities(entities);
		await this.plugin.store.writeDbTypes(
			this.types.map((x) => (x.name === from ? { ...x, name: to } : x))
		);
		new Notice(
			n
				? `范畴「${from}」已改名为「${to}」，${n} 个词条已更新。`
				: `范畴「${from}」已改名为「${to}」。`
		);
		await this.reload();
	}

	private async mergeType(from: string, into: string): Promise<void> {
		const entities = await this.plugin.store.readEntities();
		let n = 0;
		for (const e of entities.values())
			if (e.type === from) {
				e.type = into;
				n++;
			}
		if (n) await this.plugin.store.writeEntities(entities);
		await this.plugin.store.writeDbTypes(
			this.types.filter((x) => x.name !== from)
		);
		new Notice(`范畴「${from}」已合并到「${into}」，${n} 个词条已更新。`);
		await this.reload();
	}

	// Deleting an empty type is immediate; a non-empty one demands a
	// destination for its entities first.
	private deleteType(t: DbType, e: MouseEvent): void {
		const count = this.typeCount(t.name);
		if (!count) {
			void (async () => {
				await this.plugin.store.writeDbTypes(
					this.types.filter((x) => x.name !== t.name)
				);
				new Notice(`范畴「${t.name}」已删除。`);
				await this.reload();
			})();
			return;
		}
		const menu = new Menu();
		for (const other of this.types) {
			if (other.name === t.name) continue;
			menu.addItem((item) =>
				item
					.setTitle(`${count} 个词条迁移到「${other.name}」后删除`)
					.setIcon("corner-down-right")
					.onClick(() => void this.mergeType(t.name, other.name))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle(`留为未知范畴并删除（不推荐）`)
				.setIcon("alert-triangle")
				.onClick(() =>
					void (async () => {
						await this.plugin.store.writeDbTypes(
							this.types.filter((x) => x.name !== t.name)
						);
						new Notice(
							`范畴「${t.name}」已删除；${count} 个词条现为未知范畴。`
						);
						await this.reload();
					})()
				)
		);
		menu.showAtMouseEvent(e);
	}

	// External entry points (commands) land on a specific section.
	showSection(section: "entities" | "types" | "quizzes"): void {
		if (this.current().kind === section) return;
		if (section === "types") this.replace({ kind: "types", scroll: 0 });
		else if (section === "quizzes")
			this.replace({
				kind: "quizzes",
				query: "",
				status: "active",
				scroll: 0,
			});
		else
			this.replace({
				kind: "entities",
				query: "",
				types: [],
				tags: [],
				sort: this.sort,
				health: "all",
				scroll: 0,
			});
	}
}
