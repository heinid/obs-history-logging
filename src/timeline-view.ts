import {
	ButtonComponent,
	ItemView,
	MarkdownRenderer,
	Notice,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { TimelineEntry, scanVault } from "./scan";
import { describeYear, parseYearTag, truncateTag } from "./year-tag";
import { Profile } from "./profiles";
import { EraSystem, eraAt } from "./eras";
import { matchesQuery, parseQuery } from "./query";
import { jumpToLocation } from "./jump";
import { EV_SYMBOL } from "./constants";
import { stripEvMarkers, stripImages, stripTags } from "./parser";
import { addEventForEntry } from "./commands";

export const TIMELINE_VIEW_TYPE = "history-logging-timeline";

export class TimelineView extends ItemView {
	private entries: TimelineEntry[] = [];
	private profiles: Profile[] = [];
	private eraSystems: EraSystem[] = [];
	private activeSystem = ""; // era-system lens name; "" = none (century fallback)
	private activeProfile = 0;
	private query = "";
	private listEl!: HTMLElement;
	private cardEls = new Map<TimelineEntry, HTMLElement>();
	// Cards in render order with their year sort keys, for year-aligned sync.
	private cardIndex: { key: number; el: HTMLElement }[] = [];
	// When on, this pane follows (and drives) the shared year position of the
	// other synced timeline panes — parallel comparison falls out of opening
	// several timelines with different profiles and linking them.
	syncEnabled = false;
	private suppressSyncUntil = 0;

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
		this.eraSystems = await this.plugin.store.readEraSystems();
		if (this.activeProfile >= this.profiles.length) this.activeProfile = 0;
		this.syncSystemToProfile();
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
			this.syncSystemToProfile();
			systemSel.value = this.activeSystem;
			this.renderList();
		});

		// Era-system lens: renames the axis's segments (pure grouping, no filter).
		const systemSel = bar.createEl("select", { cls: "hl-system-select" });
		systemSel.createEl("option", { text: "No era system", value: "" });
		this.eraSystems.forEach((s) => {
			systemSel.createEl("option", { text: s.name, value: s.name });
		});
		systemSel.value = this.activeSystem;
		systemSel.addEventListener("change", () => {
			this.activeSystem = systemSel.value;
			this.renderList();
		});

		const manageBtn = new ButtonComponent(bar);
		manageBtn.setTooltip("Manage era systems");
		manageBtn.buttonEl.addClass("hl-icon-btn");
		setIcon(manageBtn.buttonEl, "settings-2");
		manageBtn.onClick(() => void this.plugin.openEraManager());

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

		// Year-sync toggle: linked panes scroll together, aligned by year.
		const syncBtn = new ButtonComponent(bar);
		syncBtn.setTooltip("Sync scrolling with other timelines (align by year)");
		syncBtn.buttonEl.addClass("hl-icon-btn");
		const paintSync = () => {
			setIcon(syncBtn.buttonEl, this.syncEnabled ? "link" : "unlink");
			syncBtn.buttonEl.toggleClass("hl-sync-on", this.syncEnabled);
		};
		paintSync();
		syncBtn.onClick(() => {
			this.syncEnabled = !this.syncEnabled;
			paintSync();
		});

		this.listEl = root.createDiv({ cls: "hl-timeline-list" });
		this.registerDomEvent(root, "scroll", () => this.onScroll());
		this.renderList();
	}

	private renderList(): void {
		const list = this.listEl;
		list.empty();
		this.cardEls.clear();
		this.cardIndex = [];

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

		const system = this.activeSystem
			? this.eraSystems.find((s) => s.name === this.activeSystem) ?? null
			: null;
		const grouped = !!system || profile.groupBy !== "none";

		let lastGroup: string | null = null;
		for (const entry of visible) {
			const { label, sub } = this.groupLabel(entry, profile, system);
			if (grouped && label !== lastGroup) {
				const h = list.createEl("h3", { cls: "hl-group" });
				h.createSpan({ text: label });
				if (sub) h.createSpan({ cls: "hl-group-range", text: sub });
				lastGroup = label;
			}
			this.renderCard(list, entry);
		}
	}

	// Resolve the active era-system to the profile's default, if it still exists.
	private syncSystemToProfile(): void {
		const want = this.profiles[this.activeProfile]?.eraSystem ?? "";
		this.activeSystem = this.eraSystems.some((s) => s.name === want) ? want : "";
	}

	private groupLabel(
		entry: TimelineEntry,
		profile: Profile,
		system: EraSystem | null
	): { label: string; sub: string } {
		if (system) {
			const hit = eraAt(system, entry.decoded.sortKey);
			// Fall back to the century heading for years the system doesn't cover.
			if (hit) return { label: hit.name, sub: hit.range };
			return { label: describeYear(entry.decoded), sub: "" };
		}
		if (profile.groupBy === "none") return { label: "", sub: "" };
		const truncated = truncateTag(entry.tag, profile.groupBy) ?? entry.tag;
		const gd = parseYearTag(truncated) ?? entry.decoded;
		return { label: describeYear(gd), sub: "" };
	}

	private renderCard(parent: HTMLElement, entry: TimelineEntry): void {
		const hasSummary = !!entry.summary?.trim();

		const card = parent.createDiv({ cls: "hl-card" });
		card.addClass(hasSummary ? "hl-has-summary" : "hl-no-summary");
		this.cardEls.set(entry, card);
		this.cardIndex.push({ key: entry.decoded.sortKey, el: card });

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
			).then(() => this.wireBlockTags(content, entry));
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

	// Within an expanded block: emphasise the exact year tag this card is about,
	// and make every other year tag a shortcut that scrolls to its own card —
	// the same block's other moments on the timeline. Ordinals disambiguate
	// repeated tags in one paragraph.
	private wireBlockTags(content: HTMLElement, entry: TimelineEntry): void {
		const seen = new Map<string, number>();
		for (const el of Array.from(content.querySelectorAll<HTMLElement>("a.tag"))) {
			const text = (el.textContent ?? "").trim();
			if (!parseYearTag(text)) continue;
			const ord = seen.get(text) ?? 0;
			seen.set(text, ord + 1);
			if (text === entry.tag && ord === entry.tagOrdinal) {
				el.addClass("hl-target-tag");
				continue;
			}
			el.addClass("hl-sibling-tag");
			el.setAttr("aria-label", "Go to this year's entry");
			el.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const sib = this.entries.find(
					(s) =>
						s.filePath === entry.filePath &&
						s.block === entry.block &&
						s.tag === text &&
						s.tagOrdinal === ord
				);
				if (sib) this.scrollToEntry(sib);
			});
		}
	}

	// Scroll the timeline to another entry's card and flash it.
	private scrollToEntry(target: TimelineEntry): void {
		const card = this.cardEls.get(target);
		if (!card) {
			new Notice("That entry is hidden by the current filter.");
			return;
		}
		card.scrollIntoView({ behavior: "smooth", block: "center" });
		card.addClass("hl-flash-card");
		window.setTimeout(() => card.removeClass("hl-flash-card"), 1300);
	}

	// Broadcast this pane's topmost visible year to the other synced panes.
	private onScroll(): void {
		if (!this.syncEnabled || Date.now() < this.suppressSyncUntil) return;
		const top = this.contentEl.getBoundingClientRect().top;
		const first = this.cardIndex.find(
			(c) => c.el.getBoundingClientRect().bottom > top
		);
		if (first) this.plugin.broadcastYear(this, first.key);
	}

	// Scroll so the first card at/after `key` sits at the top of the pane.
	alignToYear(key: number): void {
		if (!this.syncEnabled) return;
		const target =
			this.cardIndex.find((c) => c.key >= key) ??
			this.cardIndex[this.cardIndex.length - 1];
		if (!target) return;
		this.suppressSyncUntil = Date.now() + 200;
		const box = this.contentEl.getBoundingClientRect();
		this.contentEl.scrollTop +=
			target.el.getBoundingClientRect().top - box.top - 8;
	}
}
