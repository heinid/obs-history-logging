import { Menu, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { GroupBy, Profile } from "./profiles";
import { EraSystem } from "./eras";
import { tokenise } from "./query";
import { NameModal } from "./name-modal";
import { TagSuggest } from "./tag-suggest";
import { isTimelineShow, TimelineShow } from "./layouts";

// The top bar reads as the pane's self-description, left to right:
//   filter (query-builder chips + free text) → lens (era system) → view.
// The query builder is the single filtering layer — what you see in it is
// exactly what filters the list. The lens only renames the axis's segments.
// A "view" (profile) is a saved snapshot of this whole state: load one and
// the bar fills in; tweak anything and it becomes an unsaved variant you can
// save back or save as a new view. profiles.md stays the plain-text truth.
export class FilterBar {
	private chips: string[] = [];
	private draft = "";
	lens = "";
	groupBy: GroupBy = "century";
	profileName = "";
	show: TimelineShow = "events";

	private barEl!: HTMLElement;
	private trailing?: (row: HTMLElement) => void;
	private chipsEl!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private viewBtn!: HTMLButtonElement;
	private countEl!: HTMLElement;

	constructor(
		private plugin: HistoryLoggingPlugin,
		private host: {
			getProfiles(): Profile[];
			getEraSystems(): EraSystem[];
			setProfiles(profiles: Profile[]): void;
			onChange(): void;
		}
	) {}

	// The pane's effective query: committed chips AND the live draft text.
	query(): string {
		return [...this.chips, this.draft.trim()].filter(Boolean).join(" ");
	}

	getState(): {
		filter: string;
		lens: string;
		groupBy: GroupBy;
		profile: string;
		show: TimelineShow;
	} {
		return {
			filter: this.query(),
			lens: this.lens,
			groupBy: this.groupBy,
			profile: this.profileName,
			show: this.show,
		};
	}

	setState(s: Record<string, unknown>): boolean {
		let touched = false;
		if (typeof s.filter === "string") {
			this.chips = tokenise(s.filter);
			this.draft = "";
			touched = true;
		}
		if (typeof s.lens === "string") {
			this.lens = s.lens;
			touched = true;
		}
		const g = s.groupBy;
		if (g === "century" || g === "decade" || g === "none") {
			this.groupBy = g;
			touched = true;
		}
		if (typeof s.profile === "string") {
			this.profileName = s.profile;
			touched = true;
		}
		if (typeof s.show === "string" && isTimelineShow(s.show)) {
			this.show = s.show;
			touched = true;
		}
		return touched;
	}

	// A track is the per-column slice of the bar's state (filter + lens +
	// loaded view); the shared groupBy stays on the bar.
	getTrack(): { filter: string; lens: string; profile: string } {
		return { filter: this.query(), lens: this.lens, profile: this.profileName };
	}

	loadTrack(t: { filter: string; lens: string; profile: string }): void {
		this.chips = tokenise(t.filter);
		this.draft = "";
		this.lens = this.resolveLens(t.lens);
		this.profileName = t.profile;
	}

	loadProfile(p: Profile): void {
		this.chips = tokenise(p.match);
		this.draft = "";
		this.groupBy = p.groupBy;
		this.lens = this.resolveLens(p.eraSystem);
		this.profileName = p.name;
	}

	setCount(shown: number, total: number): void {
		this.countEl.setText(shown === total ? `${total}` : `${shown} / ${total}`);
	}

	render(bar: HTMLElement, trailing?: (row: HTMLElement) => void): void {
		this.barEl = bar;
		if (trailing) this.trailing = trailing;
		bar.empty();

		// Row 1 — filter. Chips are committed terms; the input is a live draft.
		const filterRow = bar.createDiv({ cls: "hl-bar-row" });
		const box = filterRow.createDiv({ cls: "hl-filter-box" });
		const fIcon = box.createSpan({ cls: "hl-filter-icon" });
		setIcon(fIcon, "filter");
		this.chipsEl = box.createSpan({ cls: "hl-chips" });
		this.inputEl = box.createEl("input", {
			cls: "hl-filter-input",
			attr: {
				type: "text",
				placeholder: 'Filter: tag / keyword / OR / -not / "phrase"',
			},
		});
		this.inputEl.value = this.draft;
		this.inputEl.addEventListener("input", () => {
			this.draft = this.inputEl.value;
			this.emit();
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && this.inputEl.value.trim()) {
				this.chips.push(...tokenise(this.inputEl.value.trim()));
				this.draft = "";
				this.inputEl.value = "";
				this.paintChips();
				this.emit();
			} else if (
				e.key === "Backspace" &&
				this.inputEl.value === "" &&
				this.chips.length
			) {
				this.chips.pop();
				this.paintChips();
				this.emit();
			}
		});
		new TagSuggest(this.plugin.app, this.inputEl);
		box.addEventListener("click", () => this.inputEl.focus());
		this.countEl = filterRow.createSpan({ cls: "hl-count" });
		this.paintChips();

		// Row 2 — lens (pure grouping, never filters) and the saved-view menu.
		const lensRow = bar.createDiv({ cls: "hl-bar-row" });
		const lensWrap = lensRow.createDiv({ cls: "hl-lens" });
		const lIcon = lensWrap.createSpan({ cls: "hl-lens-icon" });
		setIcon(lIcon, "glasses");
		lensWrap.createSpan({ cls: "hl-lens-label", text: "Lens" });
		const lensSel = lensWrap.createEl("select", { cls: "hl-lens-select" });
		lensSel.createEl("option", { text: "None (by period)", value: "" });
		this.host.getEraSystems().forEach((s) => {
			lensSel.createEl("option", { text: s.name, value: s.name });
		});
		lensSel.value = this.lens;
		lensSel.setAttr(
			"aria-label",
			"Era-system lens: renames the axis's segments, never filters"
		);
		lensSel.addEventListener("change", () => {
			this.lens = lensSel.value;
			this.emit();
		});
		const manage = lensWrap.createEl("button", { cls: "hl-icon-btn" });
		setIcon(manage, "settings-2");
		manage.setAttr("aria-label", "Manage era systems");
		manage.addEventListener("click", () => void this.plugin.openEraManager());

		const groupWrap = lensRow.createDiv({ cls: "hl-lens hl-groupby" });
		groupWrap.createSpan({ cls: "hl-lens-label", text: "Group" });
		const groupSel = groupWrap.createEl("select", { cls: "hl-lens-select" });
		for (const [v, t] of [
			["century", "Century"],
			["decade", "Decade"],
			["none", "No headings"],
		]) {
			groupSel.createEl("option", { text: t, value: v });
		}
		groupSel.value = this.groupBy;
		groupSel.setAttr("aria-label", "Fallback grouping where no lens applies");
		groupSel.addEventListener("change", () => {
			this.groupBy = groupSel.value as GroupBy;
			this.emit();
		});

		const showWrap = lensRow.createDiv({ cls: "hl-lens hl-show" });
		showWrap.createSpan({ cls: "hl-lens-label", text: "Show" });
		const showSel = showWrap.createEl("select", { cls: "hl-lens-select" });
		for (const [value, label] of [
			["events", "Events"],
			["active-quizzes", "Active quizzes"],
			["mastered-quizzes", "Mastered quizzes"],
			["all-quizzes", "All quizzes"],
		] as [TimelineShow, string][])
			showSel.createEl("option", { value, text: label });
		showSel.value = this.show;
		showSel.addEventListener("change", () => {
			this.show = showSel.value as TimelineShow;
			this.emit();
			this.render(this.barEl);
		});

		const spacer = lensRow.createDiv({ cls: "hl-bar-spacer" });
		void spacer;

		this.viewBtn = lensRow.createEl("button", { cls: "hl-view-btn" });
		this.viewBtn.addEventListener("click", (e) => this.openViewMenu(e));
		this.paintViewBtn();

		this.trailing?.(lensRow);
	}

	private emit(): void {
		this.paintViewBtn();
		this.host.onChange();
	}

	private paintChips(): void {
		this.chipsEl.empty();
		this.chips.forEach((chip, i) => {
			const el = this.chipsEl.createSpan({ cls: "hl-chip" });
			el.createSpan({ cls: "hl-chip-text", text: chip });
			const x = el.createSpan({ cls: "hl-chip-x" });
			setIcon(x, "x");
			x.addEventListener("click", (e) => {
				e.stopPropagation();
				this.chips.splice(i, 1);
				this.paintChips();
				this.emit();
			});
		});
	}

	private paintViewBtn(): void {
		if (!this.viewBtn) return;
		this.viewBtn.empty();
		const icon = this.viewBtn.createSpan({ cls: "hl-view-icon" });
		setIcon(icon, "bookmark");
		const p = this.currentProfile();
		this.viewBtn.createSpan({
			cls: "hl-view-name",
			text: p ? p.name : "Unsaved view",
		});
		if (!p || this.isDirty())
			this.viewBtn.createSpan({ cls: "hl-view-dirty", text: "•" });
		const caret = this.viewBtn.createSpan({ cls: "hl-view-caret" });
		setIcon(caret, "chevron-down");
		this.viewBtn.setAttr(
			"aria-label",
			"Views: save or load this pane's filter + lens"
		);
	}

	private currentProfile(): Profile | undefined {
		if (!this.profileName) return undefined;
		return this.host.getProfiles().find((p) => p.name === this.profileName);
	}

	private resolveLens(name: string): string {
		return this.host.getEraSystems().some((s) => s.name === name) ? name : "";
	}

	// Whether the bar has drifted from the loaded view's saved state.
	private isDirty(): boolean {
		const p = this.currentProfile();
		if (!p) return true;
		return (
			this.query() !== tokenise(p.match).join(" ") ||
			this.groupBy !== p.groupBy ||
			this.lens !== this.resolveLens(p.eraSystem)
		);
	}

	private snapshot(name: string): Profile {
		return {
			name,
			match: this.query(),
			groupBy: this.groupBy,
			eraSystem: this.lens,
		};
	}

	private openViewMenu(e: MouseEvent): void {
		const menu = new Menu();
		const profiles = this.host.getProfiles();
		for (const p of profiles) {
			menu.addItem((i) =>
				i
					.setTitle(p.name)
					.setIcon(p.name === this.profileName ? "check" : "bookmark")
					.onClick(() => {
						this.loadProfile(p);
						this.render(this.barEl);
						this.host.onChange();
					})
			);
		}
		menu.addSeparator();
		const cur = this.currentProfile();
		if (cur && this.isDirty()) {
			menu.addItem((i) =>
				i
					.setTitle(`Update "${cur.name}"`)
					.setIcon("save")
					.onClick(() => {
						const next = profiles.map((p) =>
							p.name === cur.name ? this.snapshot(cur.name) : p
						);
						this.host.setProfiles(next);
						this.paintViewBtn();
					})
			);
		}
		menu.addItem((i) =>
			i
				.setTitle("Save as new view…")
				.setIcon("plus")
				.onClick(() => {
					new NameModal(this.plugin.app, "Save view as", "", (name) => {
						const rest = profiles.filter((p) => p.name !== name);
						this.host.setProfiles([...rest, this.snapshot(name)]);
						this.profileName = name;
						this.paintViewBtn();
					}).open();
				})
		);
		if (cur) {
			menu.addItem((i) =>
				i
					.setTitle(`Delete "${cur.name}"`)
					.setIcon("trash")
					.onClick(() => {
						// Unlink but keep the bar's current state on screen.
						this.host.setProfiles(profiles.filter((p) => p.name !== cur.name));
						this.profileName = "";
						this.paintViewBtn();
					})
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Save layout (this view's tracks)…")
				.setIcon("layout")
				.onClick(() => this.plugin.saveLayoutInteractive())
		);
		menu.addItem((i) =>
			i
				.setTitle("Open saved layout…")
				.setIcon("layout-grid")
				.onClick(() => void this.plugin.openLayoutInteractive())
		);
		menu.showAtMouseEvent(e);
	}
}
