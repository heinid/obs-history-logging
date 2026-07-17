import { ButtonComponent, ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import {
	EraSystem,
	formatAbsYear,
	parseAbsYear,
} from "./eras";
import { ERA_TEMPLATES } from "./era-templates";

export const ERA_MANAGER_VIEW_TYPE = "history-logging-era-manager";

// A Notion-like page to add and manage era systems. Left: the list of systems.
// Right: the selected system's boundary table (year + era name), each row
// editable in place. Everything persists back to `eras.md`.
export class EraManagerView extends ItemView {
	private systems: EraSystem[] = [];
	private selected = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ERA_MANAGER_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Era systems";
	}
	getIcon(): string {
		return "layers";
	}

	async onOpen(): Promise<void> {
		this.systems = await this.plugin.store.readEraSystems();
		this.render();
	}

	private async persist(): Promise<void> {
		await this.plugin.store.writeEraSystems(this.systems);
		await this.plugin.refreshTimelines();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-eramgr");

		const sidebar = root.createDiv({ cls: "hl-eramgr-sidebar" });
		sidebar.createEl("div", { cls: "hl-eramgr-title", text: "Era systems" });

		this.systems.forEach((sys, i) => {
			const row = sidebar.createDiv({ cls: "hl-eramgr-sysrow" });
			if (i === this.selected) row.addClass("is-active");
			row.createSpan({ cls: "hl-eramgr-sysname", text: sys.name });
			const del = row.createEl("button", { cls: "hl-icon-btn hl-eramgr-del" });
			setIcon(del, "trash-2");
			del.setAttr("aria-label", "Delete system");
			del.addEventListener("click", (e) => {
				e.stopPropagation();
				this.systems.splice(i, 1);
				if (this.selected >= this.systems.length)
					this.selected = this.systems.length - 1;
				void this.persist();
				this.render();
			});
			row.addEventListener("click", () => {
				this.selected = i;
				this.render();
			});
		});

		const add = new ButtonComponent(sidebar);
		add.setButtonText("+ New system");
		add.buttonEl.addClass("hl-eramgr-add");
		add.onClick(() => this.addSystem());

		const imp = new ButtonComponent(sidebar);
		imp.setButtonText("Import from template");
		imp.buttonEl.addClass("hl-eramgr-add");
		imp.onClick((e) => this.showTemplateMenu(e));

		const main = root.createDiv({ cls: "hl-eramgr-main" });
		this.renderMain(main);
	}

	private renderMain(main: HTMLElement): void {
		main.empty();
		const sys = this.systems[this.selected];
		if (!sys) {
			main.createDiv({
				cls: "hl-empty",
				text: "No era system. Create one or import a template.",
			});
			return;
		}

		const header = main.createDiv({ cls: "hl-eramgr-header" });
		const nameInput = header.createEl("input", {
			cls: "hl-eramgr-nameinput",
			attr: { type: "text", value: sys.name, placeholder: "System name" },
		});
		nameInput.addEventListener("change", () => {
			sys.name = nameInput.value.trim() || sys.name;
			void this.persist();
			this.render();
		});

		const first = sys.boundaries[0];
		const last = sys.boundaries[sys.boundaries.length - 1];
		const coverage = first
			? `${first.yearLabel} – ${last ? formatAbsYear(last.startKey) : "…"} · ${sys.boundaries.length} eras`
			: "empty";
		header.createDiv({ cls: "hl-eramgr-coverage", text: coverage });

		const table = main.createDiv({ cls: "hl-eramgr-table" });
		sys.boundaries.forEach((b, i) => {
			const row = table.createDiv({ cls: "hl-eramgr-row" });
			const yr = row.createEl("input", {
				cls: "hl-eramgr-year",
				attr: { type: "text", value: b.yearLabel, placeholder: "710 / 509 BC" },
			});
			yr.addEventListener("change", () => {
				const k = parseAbsYear(yr.value);
				if (k === null) {
					yr.addClass("is-invalid");
					return;
				}
				yr.removeClass("is-invalid");
				b.startKey = k;
				b.yearLabel = yr.value.trim();
				void this.persist();
				this.render();
			});
			const nm = row.createEl("input", {
				cls: "hl-eramgr-eraname",
				attr: { type: "text", value: b.name, placeholder: "Era name" },
			});
			nm.addEventListener("change", () => {
				b.name = nm.value.trim();
				void this.persist();
			});
			const del = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(del, "x");
			del.setAttr("aria-label", "Delete era");
			del.addEventListener("click", () => {
				sys.boundaries.splice(i, 1);
				void this.persist();
				this.render();
			});
		});

		const addRow = new ButtonComponent(main);
		addRow.setButtonText("+ Add era");
		addRow.buttonEl.addClass("hl-eramgr-addrow");
		addRow.onClick(() => {
			sys.boundaries.push({ startKey: 1, yearLabel: "1", name: "" });
			void this.persist();
			this.render();
		});
	}

	private addSystem(): void {
		let n = 1;
		let name = "New system";
		while (this.systems.some((s) => s.name === name)) name = `New system ${++n}`;
		this.systems.push({ name, boundaries: [] });
		this.selected = this.systems.length - 1;
		void this.persist();
		this.render();
	}

	private showTemplateMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const tpl of ERA_TEMPLATES) {
			menu.addItem((item) => {
				item.setTitle(tpl.name).onClick(() => {
					let name = tpl.name;
					let n = 1;
					while (this.systems.some((s) => s.name === name))
						name = `${tpl.name} ${++n}`;
					this.systems.push({
						name,
						boundaries: tpl.boundaries.map((b) => ({ ...b })),
					});
					this.selected = this.systems.length - 1;
					void this.persist();
					this.render();
				});
			});
		}
		menu.showAtMouseEvent(evt);
	}
}
