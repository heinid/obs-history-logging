import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName } from "./db-format";
import { entitySearchText, parseDbMarks, stripDbMarkers } from "./db-marker";
import { entityHint } from "./live-editor";
import { EntityModal } from "./entity-modal";
import { generateId } from "./id";
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

const ROW_H = 40;
const OVERSCAN = 8;

// The entity browser: a virtualised, filterable catalogue of every entry in
// entities.md, with per-entity usage counts drawn from events.md.
export class EntityBrowserView extends ItemView {
	private rows: Row[] = [];
	private filtered: Row[] = [];
	private types: DbType[] = [];
	private query = "";
	private selectedTypes = new Set<string>();
	private sort: SortKey = "occ";
	private health: HealthKey = "all";
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
		return "Entities";
	}

	getIcon(): string {
		return "library";
	}

	async onOpen(): Promise<void> {
		// The catalogue lives in two data files; a debounced reload on either
		// keeps the list current without rescanning on every note edit.
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

	// --- filtering ------------------------------------------------------

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

	// --- rendering ------------------------------------------------------

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-entity-browser");

		const bar = root.createDiv({ cls: "hl-eb-bar" });

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

		this.countEl = root.createDiv({ cls: "hl-eb-count" });

		this.scrollEl = root.createDiv({ cls: "hl-eb-list" });
		this.spacerEl = this.scrollEl.createDiv({ cls: "hl-eb-spacer" });
		this.registerDomEvent(this.scrollEl, "scroll", () =>
			this.renderWindow()
		);
		this.refreshList();
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

		el.addEventListener("click", () =>
			void this.plugin.openEntityView(row.entity.id)
		);
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.openRowMenu(e, row);
		});
		return el;
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
					.onClick(() =>
						void this.plugin.openEntityView(row.entity.id)
					)
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
				.setTitle("打开词条页")
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
}
