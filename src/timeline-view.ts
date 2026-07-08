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
import { stripEvMarkers, stripImages, stripTags } from "./parser";
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
		const hasSummary = !!entry.summary?.trim();

		const card = parent.createDiv({ cls: "hl-card" });
		card.addClass(hasSummary ? "hl-has-summary" : "hl-no-summary");

		const head = card.createDiv({ cls: "hl-card-head" });
		head.createSpan({ cls: "hl-year", text: describeYear(entry.decoded) });
		head.createSpan({ cls: "hl-tag", text: entry.tag });
		if (entry.evId) head.createSpan({ cls: "hl-ev-symbol", text: EV_SYMBOL });
		head.createSpan({ cls: "hl-file", text: entry.fileName });

		// Per-card actions (revealed on hover): write/edit summary in place, and
		// an explicit jump — so clicking the card body only expands, never navigates.
		const actions = head.createDiv({ cls: "hl-card-actions" });
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
			void jumpToLocation(
				this.app,
				entry.filePath,
				entry.offset,
				entry.tag.length
			);
		});

		// Collapsed preview: the summary if written, else the tag's own line
		// (ev syntax + images stripped, and tags stripped unless the setting is off).
		let line = stripImages(stripEvMarkers(entry.snippet));
		if (this.plugin.settings.hideTagsInPreview) line = stripTags(line);
		const preview = hasSummary
			? entry.summary!
			: line.replace(/\s+/g, " ").trim() || "*(no text)*";
		// Expanded: the full surrounding block, raw (images + every tag).
		const full = stripEvMarkers(entry.block).trim();

		const norm = (s: string) =>
			stripTags(stripImages(s)).replace(/\s+/g, " ").trim();
		const hasImage = full !== stripImages(full);
		const expandable =
			!!full && (hasSummary || norm(full) !== norm(preview) || hasImage);

		const body = card.createDiv({ cls: "hl-card-body" });
		const content = body.createDiv();

		if (expandable) {
			const chevron = head.createSpan({ cls: "hl-chevron" });
			this.wireExpand(card, content, chevron, entry, preview, hasSummary, full);
		} else {
			this.renderContent(content, entry, preview, hasSummary, false);
		}
	}

	// Toggle a card between its collapsed preview and the full block in place,
	// so expanding replaces (never stacks on) the preview and always folds back.
	private wireExpand(
		card: HTMLElement,
		content: HTMLElement,
		chevron: HTMLElement,
		entry: TimelineEntry,
		preview: string,
		hasSummary: boolean,
		full: string
	): void {
		let expanded = false;
		const paint = () => {
			this.renderContent(content, entry, preview, hasSummary, expanded, full);
			card.toggleClass("hl-expanded", expanded);
			setIcon(chevron, expanded ? "chevron-up" : "chevron-down");
		};
		paint();
		card.addClass("hl-expandable");
		card.addEventListener("click", (e) => {
			const t = e.target as HTMLElement;
			// Leave links, buttons and active text selections alone — the body
			// stays selectable/copyable, only a clean click toggles expansion.
			if (t.tagName === "A" || t.closest("button")) return;
			if ((window.getSelection()?.toString() ?? "") !== "") return;
			expanded = !expanded;
			paint();
		});
	}

	private renderContent(
		content: HTMLElement,
		entry: TimelineEntry,
		preview: string,
		hasSummary: boolean,
		expanded: boolean,
		full = ""
	): void {
		content.empty();
		content.className = "";
		if (expanded) {
			content.addClass("hl-content", "hl-context");
			void MarkdownRenderer.render(
				this.app,
				full,
				content,
				entry.filePath,
				this.plugin
			).then(() => this.highlightTargetTag(content, entry));
			return;
		}
		content.addClass("hl-content", "hl-summary", "hl-clamp");
		if (!hasSummary) content.addClass("hl-from-note");
		void MarkdownRenderer.render(
			this.app,
			preview,
			content,
			entry.filePath,
			this.plugin
		);
	}

	// Emphasise the exact year tag this card is about within the expanded block,
	// picking the right occurrence when the paragraph repeats the same tag.
	private highlightTargetTag(content: HTMLElement, entry: TimelineEntry): void {
		const matches = Array.from(
			content.querySelectorAll<HTMLElement>("a.tag")
		).filter((el) => (el.textContent ?? "").trim() === entry.tag);
		const target = matches[entry.tagOrdinal] ?? matches[0];
		target?.addClass("hl-target-tag");
	}
}
