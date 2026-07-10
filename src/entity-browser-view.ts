import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName } from "./db-format";
import { entitySearchText, parseDbMarks, stripDbMarkers } from "./db-marker";
import { entityHint } from "./live-editor";
import { EntityModal } from "./entity-modal";
import { generateId } from "./id";
import { renderEntityPage } from "./entity-page";
import { describeYear, parseYearTag } from "./year-tag";

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

// Browser-style navigation stack: every place you can be in the backstage is
// a frame; back/forward restores it including scroll position and filters.
type NavFrame =
	| {
			kind: "entities";
			query: string;
			types: string[];
			sort: SortKey;
			health: HealthKey;
			scroll: number;
	  }
	| { kind: "types"; scroll: number }
	| { kind: "entity"; id: string; scroll: number };

const ROW_H = 40;
const OVERSCAN = 8;

// The plugin backstage: entity catalogue and type manager as sections of one
// tab, with wiki-style in-place navigation into entity pages.
export class EntityBrowserView extends ItemView {
	private rows: Row[] = [];
	private filtered: Row[] = [];
	private types: DbType[] = [];
	private query = "";
	private selectedTypes = new Set<string>();
	private sort: SortKey = "occ";
	private health: HealthKey = "all";
	private stack: NavFrame[] = [
		{ kind: "entities", query: "", types: [], sort: "occ", health: "all", scroll: 0 },
	];
	private pos = 0;
	private bodyEl?: HTMLElement;
	private navBack?: HTMLButtonElement;
	private navFwd?: HTMLButtonElement;
	private tabEls = new Map<string, HTMLElement>();
	private countEl?: HTMLElement;
	private scrollEl?: HTMLElement;
	private spacerEl?: HTMLElement;
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
					f.path === `${folder}/db-types.md`
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
		const [entities, events, types] = await Promise.all([
			this.plugin.store.readEntities(),
			this.plugin.store.readEvents(),
			this.plugin.store.readDbTypes(),
		]);
		this.types = types;
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
		this.render();
	}

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
			f.sort = this.sort;
			f.health = this.health;
			f.scroll = scroll;
		} else f.scroll = scroll;
	}

	private bodyScroll(): number {
		if (this.current().kind === "entities")
			return this.scrollEl?.scrollTop ?? 0;
		return this.bodyEl?.scrollTop ?? 0;
	}

	private push(frame: NavFrame): void {
		this.snapshot();
		this.stack.splice(this.pos + 1);
		this.stack.push(frame);
		this.pos = this.stack.length - 1;
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
		const mkTab = (key: "entities" | "types", label: string): void => {
			const el = tabs.createSpan({ cls: "hl-eb-tab", text: label });
			this.tabEls.set(key, el);
			el.addEventListener("click", () => {
				if (this.current().kind === key) return;
				this.push(
					key === "entities"
						? {
								kind: "entities",
								query: this.query,
								types: [...this.selectedTypes],
								sort: this.sort,
								health: this.health,
								scroll: 0,
						  }
						: { kind: "types", scroll: 0 }
				);
			});
		};
		mkTab("entities", "词条");
		mkTab("types", "范畴");
		const cur = this.current();
		const activeTab = cur.kind === "types" ? "types" : "entities";
		this.tabEls.get(activeTab)?.addClass("is-active");
		if (cur.kind === "entity") {
			const crumb = nav.createSpan({ cls: "hl-eb-crumb" });
			const row = this.rows.find((r) => r.entity.id === cur.id);
			crumb.setText(`› ${row ? displayName(row.entity) : cur.id}`);
		}

		this.bodyEl = root.createDiv({ cls: "hl-eb-body" });
		if (cur.kind === "entities") this.renderEntities(this.bodyEl, cur);
		else if (cur.kind === "types") this.renderTypes(this.bodyEl, cur);
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
		this.sort = frame.sort;
		this.health = frame.health;

		const bar = host.createDiv({ cls: "hl-eb-bar" });

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

		const pills = bar.createDiv({ cls: "hl-eb-pills" });
		for (const t of this.types) {
			const pill = pills.createSpan({
				cls: "hl-type-pill hl-eb-pill",
				text: t.name,
			});
			const paint = (): void => {
				const on = this.selectedTypes.has(t.name);
				pill.toggleClass("is-active", on);
				pill.style.color = on ? "#fff" : t.color;
				pill.style.borderColor = t.color;
				pill.style.backgroundColor = on ? t.color : "";
			};
			paint();
			pill.addEventListener("click", () => {
				if (this.selectedTypes.has(t.name))
					this.selectedTypes.delete(t.name);
				else this.selectedTypes.add(t.name);
				paint();
				this.refreshList();
			});
		}

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

		this.countEl = host.createDiv({ cls: "hl-eb-count" });

		this.scrollEl = host.createDiv({ cls: "hl-eb-list" });
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
	}

	private applyFilters(): void {
		const q = this.query.trim().toLowerCase();
		this.filtered = this.rows.filter((r) => {
			if (
				this.selectedTypes.size &&
				!this.selectedTypes.has(r.entity.type)
			)
				return false;
			if (this.health === "unused" && r.occ.length) return false;
			if (this.health === "no-notes" && r.entity.body.trim())
				return false;
			if (!q) return true;
			return (
				entitySearchText(r.entity).toLowerCase().includes(q) ||
				r.entity.body.toLowerCase().includes(q)
			);
		});
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
		const pill = el.createSpan({
			cls: "hl-type-pill hl-type-pill-static hl-eb-row-pill",
			text: row.entity.type || "?",
		});
		const color = this.typeColor(row.entity.type);
		if (color) {
			pill.style.color = color;
			pill.style.borderColor = color;
		}
		const hint = entityHint(row.entity, displayName(row.entity));
		if (hint) el.createSpan({ cls: "hl-eb-hint", text: hint });

		const badge = el.createSpan({
			cls: `hl-eb-badge${row.occ.length ? "" : " is-zero"}`,
			text: row.occ.length ? `×${row.occ.length}` : "未使用",
		});
		if (row.occ.length)
			badge.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openOccMenu(e, row);
			});

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

	private async deleteEntity(row: Row): Promise<void> {
		await this.plugin.store.removeEntity(row.entity.id);
		const n = row.occ.length;
		new Notice(
			n
				? `已删除词条「${displayName(row.entity)}」。正文中 ${n} 处标注将失效。`
				: `已删除词条「${displayName(row.entity)}」。`
		);
		await this.reload();
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
			openEntity: (id) => this.openEntityInPlace(id),
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
				this.push({
					kind: "entities",
					query: "",
					types: [t.name],
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
	showSection(section: "entities" | "types"): void {
		if (this.current().kind === section) return;
		this.push(
			section === "types"
				? { kind: "types", scroll: 0 }
				: {
						kind: "entities",
						query: "",
						types: [],
						sort: this.sort,
						health: "all",
						scroll: 0,
				  }
		);
	}
}
