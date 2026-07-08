import {
	ButtonComponent,
	ItemView,
	MarkdownRenderer,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { TimelineEntry, scanVault } from "./scan";
import { describeYear, parseYearTag, truncateTag } from "./year-tag";
import { Profile } from "./profiles";
import { matchesQuery, parseQuery } from "./query";
import { jumpToLocation } from "./jump";
import { EV_SYMBOL } from "./constants";
import { stripEvMarkers, stripImages } from "./parser";
import { addEventForEntry } from "./commands";

export const TIMELINE_VIEW_TYPE = "history-logging-timeline";

export class TimelineView extends ItemView {
	private entries: TimelineEntry[] = [];
	private profiles: Profile[] = [];
	private activeProfile = 0;
	private query = "";
	private listEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return TIMELINE_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "History timeline";
	}
	getIcon(): string {
		return "history";
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	// Re-scan the vault and rebuild everything.
	async refresh(): Promise<void> {
		this.profiles = await this.plugin.store.readProfiles();
		if (this.activeProfile >= this.profiles.length) this.activeProfile = 0;
		this.entries = await scanVault(
			this.app,
			this.plugin.store,
			this.plugin.settings.dataFolder
		);
		this.renderChrome();
	}

	private renderChrome(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-timeline");

		const bar = root.createDiv({ cls: "hl-timeline-bar" });

		const profileSel = bar.createEl("select", { cls: "hl-profile-select" });
		this.profiles.forEach((p, i) => {
			profileSel.createEl("option", { text: p.name, value: String(i) });
		});
		profileSel.value = String(this.activeProfile);
		profileSel.addEventListener("change", () => {
			this.activeProfile = Number(profileSel.value);
			this.renderList();
		});

		const search = bar.createEl("input", {
			cls: "hl-timeline-search",
			attr: { type: "text", placeholder: 'Search  (AND / OR / -not / "phrase")' },
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.renderList();
		});

		const refreshBtn = new ButtonComponent(bar);
		refreshBtn.setTooltip("Rescan vault");
		refreshBtn.buttonEl.addClass("hl-icon-btn");
		setIcon(refreshBtn.buttonEl, "refresh-cw");
		refreshBtn.onClick(() => this.refresh());

		this.listEl = root.createDiv({ cls: "hl-timeline-list" });
		this.renderList();
	}

	private renderList(): void {
		const list = this.listEl;
		list.empty();

		const profile = this.profiles[this.activeProfile];
		const basePq = parseQuery(profile.match);
		const userPq = parseQuery(this.query);

		const visible = this.entries.filter((e) => {
			const hay = `${e.tag} ${e.snippet} ${e.summary ?? ""}`.toLowerCase();
			return matchesQuery(hay, basePq) && matchesQuery(hay, userPq);
		});

		if (visible.length === 0) {
			list.createDiv({ cls: "hl-empty", text: "No dated notes match." });
			return;
		}

		let lastGroup: string | null = null;
		for (const entry of visible) {
			const group = this.groupLabel(entry, profile);
			if (profile.groupBy !== "none" && group !== lastGroup) {
				list.createEl("h3", { cls: "hl-group", text: group });
				lastGroup = group;
			}
			this.renderCard(list, entry);
		}
	}

	private groupLabel(entry: TimelineEntry, profile: Profile): string {
		if (profile.groupBy === "none") return "";
		const truncated = truncateTag(entry.tag, profile.groupBy) ?? entry.tag;
		const gd = parseYearTag(truncated) ?? entry.decoded;
		return describeYear(gd);
	}

	private renderCard(parent: HTMLElement, entry: TimelineEntry): void {
		const card = parent.createDiv({ cls: "hl-card" });

		const head = card.createDiv({ cls: "hl-card-head" });
		head.createSpan({ cls: "hl-year", text: describeYear(entry.decoded) });
		head.createSpan({ cls: "hl-tag", text: entry.tag });
		if (entry.evId) head.createSpan({ cls: "hl-ev-symbol", text: EV_SYMBOL });
		head.createSpan({ cls: "hl-file", text: entry.fileName });

		// Per-card actions (revealed on hover): write/edit summary in place, and
		// an explicit jump — so clicking the card body never navigates by accident.
		const actions = head.createDiv({ cls: "hl-card-actions" });
		const hasSummary = !!entry.summary?.trim();
		const editBtn = actions.createEl("button", { cls: "hl-icon-btn" });
		setIcon(editBtn, hasSummary || entry.evId ? "pencil" : "plus");
		editBtn.setAttr(
			"aria-label",
			hasSummary || entry.evId ? "Edit summary" : "Add summary"
		);
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void addEventForEntry(this.plugin, entry, () => this.refresh());
		});
		const openBtn = actions.createEl("button", { cls: "hl-icon-btn" });
		setIcon(openBtn, "arrow-up-right");
		openBtn.setAttr("aria-label", "Open note");
		openBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			jumpToLocation(this.app, entry.filePath, entry.offset);
		});

		// Body: a written summary, else the tag's own line (images / ev syntax
		// stripped), clamped to a generous cap.
		const body = card.createDiv({ cls: "hl-card-body" });
		const preview = hasSummary
			? entry.summary!
			: stripImages(stripEvMarkers(entry.snippet)).trim() || "*(no text)*";
		const md = body.createDiv({ cls: "hl-summary hl-clamp" });
		if (!hasSummary) md.addClass("hl-from-note");
		MarkdownRenderer.render(this.app, preview, md, entry.filePath, this.plugin);

		// Expand to the full surrounding block (images included), lazily rendered.
		const full = stripEvMarkers(entry.block).trim();
		this.addExpander(card, entry, preview, full);
	}

	// Add a "Show context" toggle when the surrounding block has more than the
	// preview line. The block is rendered on first expand.
	private addExpander(
		card: HTMLElement,
		entry: TimelineEntry,
		preview: string,
		full: string
	): void {
		const previewText = stripImages(preview).replace(/\s+/g, " ").trim();
		const fullText = stripImages(full).replace(/\s+/g, " ").trim();
		const hasImage = full !== stripImages(full);
		if (!full || (fullText === previewText && !hasImage)) return;

		const more = card.createDiv({ cls: "hl-card-context" });
		more.hide();
		let built = false;

		const toggle = card.createEl("button", { cls: "hl-expand" });
		const icon = toggle.createSpan({ cls: "hl-expand-icon" });
		setIcon(icon, "chevron-down");
		const label = toggle.createSpan({ text: "Show context" });
		toggle.addEventListener("click", (e) => {
			e.stopPropagation();
			const show = !more.isShown();
			if (show && !built) {
				MarkdownRenderer.render(
					this.app,
					full,
					more,
					entry.filePath,
					this.plugin
				);
				built = true;
			}
			more.toggle(show);
			setIcon(icon, show ? "chevron-up" : "chevron-down");
			label.setText(show ? "Hide context" : "Show context");
		});
	}
}
