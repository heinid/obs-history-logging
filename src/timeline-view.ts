import {
	ButtonComponent,
	ItemView,
	MarkdownRenderer,
	Notice,
	ViewStateResult,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { TimelineEntry, scanVault } from "./scan";
import { describeYear, parseYearTag } from "./year-tag";
import { Profile } from "./profiles";
import { EraSystem, eraAt } from "./eras";
import { matchesQuery, parseQuery } from "./query";
import { FilterBar } from "./filter-bar";
import {
	EraAnchor,
	TrackDef,
	bucketKeyFor,
	bucketLabelFor,
	nextBucketKey,
	renderTrackGrid,
	trackEntries,
	trackLabel,
} from "./track-grid";
import { jumpToLocation } from "./jump";
import { EV_SYMBOL } from "./constants";
import { stripEvMarkers, stripImages, stripTags } from "./parser";
import { dbMarkersToHtml, stripDbMarkers } from "./db-marker";
import { addEventForEntry } from "./commands";
import { openEvMenu } from "./ev-menu";
import { tracksIn } from "./tracks";
import { QuizEntry } from "./quiz";
import { renderTimelineQuizCard } from "./quiz-card";
import { TimelineShow } from "./layouts";
import { QuizSessionModal } from "./quiz-session-modal";

export const TIMELINE_VIEW_TYPE = "history-logging-timeline";

// Identity of the topmost visible card, used to restore the reader's place
// across a full rebuild (pixel scroll offsets drift when content changes).
interface ScrollAnchor {
	evId: string;
	filePath: string;
	tag: string;
	tagOrdinal: number;
	delta: number;
}

export class TimelineView extends ItemView {
	private entries: TimelineEntry[] = [];
	private quizzes = new Map<string, QuizEntry>();
	private profiles: Profile[] = [];
	private eraSystems: EraSystem[] = [];
	// The bar IS the pane's definition: filter + lens + saved-view menu.
	// With several tracks it edits whichever track is active; each track is
	// one column of the in-view comparison grid.
	private bar: FilterBar;
	private tracks: TrackDef[] = [{ filter: "", lens: "", profile: "" }];
	private active = 0;
	private restored = false; // state came from the saved workspace layout
	private initialised = false;
	private listEl?: HTMLElement;
	private barHost?: HTMLElement;
	private trackCounts: number[] = [];
	// Era-start anchors per track, feeding the floating era navigator.
	private eraAnchors: EraAnchor[][] = [];
	private navEl?: HTMLElement;
	private navSizer?: ResizeObserver;
	private navCollapsed = false;
	// Re-places the era gutter bands when the grid's geometry changes.
	private gridSizer?: ResizeObserver;
	private navItems: { anchor: EraAnchor; el: HTMLElement }[] = [];
	private cardEls = new Map<TimelineEntry, HTMLElement>();
	// Cards in render order with their year sort keys, for year jumps.
	private cardIndex: { key: number; el: HTMLElement }[] = [];
	private quizPositions = new Map<string, number>();

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
		this.bar = new FilterBar(plugin, {
			getProfiles: () => this.profiles,
			getEraSystems: () => this.eraSystems,
			setProfiles: (profiles) => {
				this.profiles = profiles;
				void this.plugin.store.writeProfiles(profiles);
			},
			onChange: () => {
				this.tracks[this.active] = this.bar.getTrack();
				this.renderList();
				this.app.workspace.requestSaveLayout();
			},
		});
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

	async onClose(): Promise<void> {
		this.navSizer?.disconnect();
		this.gridSizer?.disconnect();
	}

	// Each pane's whole definition (filter, lens, grouping, loaded view)
	// persists with the workspace layout, so panes survive restarts as-is.
	getState(): Record<string, unknown> {
		this.tracks[this.active] = this.bar.getTrack();
		return {
			...this.bar.getState(),
			tracks: this.tracks,
			active: this.active,
		};
	}

	async setState(
		state: Record<string, unknown>,
		result: ViewStateResult
	): Promise<void> {
		await super.setState(state, result);
		if (state && typeof state === "object") {
			if (this.bar.setState(state)) this.restored = true;
			if (Array.isArray(state.tracks) && state.tracks.length) {
				this.tracks = state.tracks.map((t: Record<string, unknown>) => ({
					filter: typeof t.filter === "string" ? t.filter : "",
					lens: typeof t.lens === "string" ? t.lens : "",
					profile: typeof t.profile === "string" ? t.profile : "",
				}));
				const a = state.active;
				this.active =
					typeof a === "number" && a >= 0 && a < this.tracks.length ? a : 0;
				this.bar.loadTrack(this.tracks[this.active]);
				this.restored = true;
			} else {
				// Legacy flat state (pre-tracks): treat it as a single track.
				this.tracks = [this.bar.getTrack()];
				this.active = 0;
			}
			if (this.listEl) this.renderChrome();
		}
	}

	// A plain view: one track, no filter — the default navigation landing.
	isPlainView(): boolean {
		const tracks = this.getTracks();
		return (
			this.bar.show === "events" &&
			tracks.length === 1 &&
			!tracks[0].filter.trim()
		);
	}

	getShow(): TimelineShow {
		return this.bar.show;
	}

	// Re-scan the vault and rebuild everything, keeping the reader's place:
	// the viewport is re-anchored to the same card after the rebuild.
	async refresh(): Promise<void> {
		const anchor = this.captureAnchor();
		[this.profiles, this.eraSystems, this.quizzes] = await Promise.all([
			this.plugin.store.readProfiles(),
			this.plugin.store.readEraSystems(),
			this.plugin.store.readQuizzes(),
		]);
		await this.loadDbColors();
		if (!this.initialised) {
			this.initialised = true;
			if (!this.restored && this.profiles.length) {
				this.bar.loadProfile(this.profiles[0]);
				this.tracks[this.active] = this.bar.getTrack();
			}
		}
		this.entries = await scanVault(
			this.app,
			this.plugin.store,
			this.plugin.settings.dataFolder
		);
		this.renderChrome();
		this.restoreAnchor(anchor);
	}

	// Scroll anchoring: pixel offsets drift when content changes, so the
	// viewport is anchored to the identity of its topmost visible card.
	private captureAnchor(): ScrollAnchor | null {
		if (this.contentEl.scrollTop <= 0) return null;
		const top = this.contentEl.getBoundingClientRect().top + this.barHeight();
		for (const [entry, el] of this.cardEls) {
			const r = el.getBoundingClientRect();
			if (r.bottom < top) continue;
			return {
				evId: entry.evId ?? "",
				filePath: entry.filePath,
				tag: entry.tag,
				tagOrdinal: entry.tagOrdinal,
				delta: r.top - top,
			};
		}
		return null;
	}

	private restoreAnchor(a: ScrollAnchor | null): void {
		if (!a) return;
		const entry =
			(a.evId ? this.entries.find((e) => e.evId === a.evId) : undefined) ??
			this.entries.find(
				(e) =>
					e.filePath === a.filePath &&
					e.tag === a.tag &&
					e.tagOrdinal === a.tagOrdinal
			);
		const card = entry ? this.cardEls.get(entry) : undefined;
		if (!card) return;
		const top = this.contentEl.getBoundingClientRect().top + this.barHeight();
		this.contentEl.scrollTop +=
			card.getBoundingClientRect().top - top - a.delta;
	}

	private renderChrome(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-timeline");

		const bar = root.createDiv({ cls: "hl-timeline-bar" });
		this.barHost = bar;
		this.bar.render(bar, (row) => {
			// Add a comparison column: the new track starts empty and becomes
			// the one the bar edits.
			const addBtn = new ButtonComponent(row);
			addBtn.setTooltip("Add track (comparison column)");
			addBtn.buttonEl.addClass("hl-icon-btn");
			setIcon(addBtn.buttonEl, "columns");
			addBtn.onClick(() => this.addTrack());

			const refreshBtn = new ButtonComponent(row);
			refreshBtn.setTooltip("Rescan vault");
			refreshBtn.buttonEl.addClass("hl-icon-btn");
			setIcon(refreshBtn.buttonEl, "refresh-cw");
			refreshBtn.onClick(() => this.refresh());
		});

		// Sticky offsets (track heads, navigator) hang below the bar's height.
		root.style.setProperty("--hl-bar-h", `${bar.offsetHeight}px`);

		this.listEl = root.createDiv({ cls: "hl-timeline-list" });
		this.registerDomEvent(root, "scroll", () => this.onScroll());
		this.renderList();
	}

	private practiceLayout(): void {
		const candidates = this.entries.filter((entry) =>
			this.entryMatchesShow(entry)
		);
		const visible =
			this.tracks.length > 1
				? this.tracks.flatMap((track) => trackEntries(candidates, track))
				: candidates.filter((entry) => {
						const hay = `${entry.tag} ${entry.snippet} ${
							entry.summary ?? ""
						}`.toLowerCase();
						return matchesQuery(hay, parseQuery(this.bar.query()));
				  });
		const eventIds = new Set(
			visible
				.map((entry) => entry.evId)
				.filter((id): id is string => !!id)
		);
		const quizIds = [...this.quizzes.values()]
			.filter(
				(quiz) =>
					quiz.status === "active" && eventIds.has(quiz.sourceEvId)
			)
			.map((quiz) => quiz.id);
		if (!quizIds.length) {
			new Notice("No active quizzes match this layout.");
			return;
		}
		new QuizSessionModal(this.app, this.plugin, quizIds).open();
	}

	setTracks(tracks: TrackDef[], active = 0): void {
		if (!tracks.length) return;
		this.tracks = tracks;
		this.active = Math.min(active, tracks.length - 1);
		this.bar.loadTrack(this.tracks[this.active]);
		if (this.listEl) this.renderChrome();
		this.app.workspace.requestSaveLayout();
	}

	getTracks(): TrackDef[] {
		this.tracks[this.active] = this.bar.getTrack();
		return this.tracks;
	}

	private addTrack(): void {
		this.tracks[this.active] = this.bar.getTrack();
		this.tracks.push({ filter: "", lens: "", profile: "" });
		this.active = this.tracks.length - 1;
		this.bar.loadTrack(this.tracks[this.active]);
		this.renderChrome();
		this.app.workspace.requestSaveLayout();
	}

	// Focus a track without rebuilding the grid, so clicking around a column
	// (which also expands/collapses cards) never loses scroll or expansion.
	private activateTrack(i: number): void {
		if (i === this.active) return;
		this.tracks[this.active] = this.bar.getTrack();
		this.active = i;
		this.bar.loadTrack(this.tracks[i]);
		if (this.barHost) this.bar.render(this.barHost);
		this.bar.setCount(this.trackCounts[i] ?? 0, this.entries.length);
		this.paintActiveTrack();
		this.renderEraNav();
		this.app.workspace.requestSaveLayout();
	}

	private paintActiveTrack(): void {
		const list = this.listEl;
		if (!list) return;
		for (const el of Array.from(
			list.querySelectorAll<HTMLElement>("[data-track]")
		)) {
			const t = Number(el.getAttr("data-track"));
			if (el.hasClass("hl-track-head"))
				el.toggleClass("hl-track-active", t === this.active);
		}
	}

	private removeTrack(i: number): void {
		if (this.tracks.length <= 1) return;
		const label = trackLabel(this.tracks[i], i);
		if (this.active !== i) this.tracks[this.active] = this.bar.getTrack();
		this.tracks.splice(i, 1);
		if (this.active > i) this.active -= 1;
		this.active = Math.min(this.active, this.tracks.length - 1);
		this.bar.loadTrack(this.tracks[this.active]);
		this.renderChrome();
		this.app.workspace.requestSaveLayout();
		new Notice(`Removed track "${label}".`);
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		this.cardEls.clear();
		this.cardIndex = [];
		const displayedEntries = this.entries.filter((entry) =>
			this.entryMatchesShow(entry)
		);

		this.gridSizer?.disconnect();
		this.gridSizer = undefined;

		if (this.tracks.length > 1) {
			const { counts, eraAnchors, relayout } = renderTrackGrid({
				list,
				entries: displayedEntries,
				tracks: this.tracks,
				active: this.active,
				groupBy: this.bar.groupBy,
				eraSystems: this.eraSystems,
				renderCard: (parent, entry) => this.renderCard(parent, entry),
				onActivate: (i) => this.activateTrack(i),
				onRemove: (i) => this.removeTrack(i),
			});
			const gridEl = list.querySelector<HTMLElement>(".hl-multi-grid");
			if (gridEl) {
				this.gridSizer = new ResizeObserver(() => relayout());
				this.gridSizer.observe(gridEl);
			}
			this.trackCounts = counts;
			this.eraAnchors = eraAnchors;
			this.bar.setCount(counts[this.active], displayedEntries.length);
			this.cardIndex.sort((a, b) => a.key - b.key);
			this.renderEraNav();
			return;
		}

		const pq = parseQuery(this.bar.query());
		const visible = displayedEntries.filter((e) => {
			const hay = `${e.tag} ${e.snippet} ${e.summary ?? ""}`.toLowerCase();
			return matchesQuery(hay, pq);
		});
		this.bar.setCount(visible.length, displayedEntries.length);

		// Lens and grouping are decoupled, as in the grid: headings stay the
		// neutral century/decade sections, the lens adds era bands (the full
		// skeleton, counts included) interleaved at their starting years.
		const system = this.bar.lens
			? this.eraSystems.find((s) => s.name === this.bar.lens) ?? null
			: null;
		const grouped = this.bar.groupBy !== "none";

		if (visible.length === 0 && (!grouped || !system)) {
			list.createDiv({
				cls: "hl-empty",
				text:
					this.bar.show === "events"
						? "No dated notes match."
						: "No quizzes match this view.",
			});
			return;
		}

		const anchors: EraAnchor[] = [];
		const eraCounts = new Map<string, number>();
		if (system)
			for (const e of visible) {
				const name = eraAt(system, e.decoded.sortKey)?.name;
				if (name) eraCounts.set(name, (eraCounts.get(name) ?? 0) + 1);
			}
		let nextBoundary = 0;
		const emitBands = (upTo: number): void => {
			if (!system) return;
			while (
				nextBoundary < system.boundaries.length &&
				system.boundaries[nextBoundary].startKey <= upTo
			) {
				const hit = eraAt(system, system.boundaries[nextBoundary].startKey);
				nextBoundary++;
				if (!hit) continue;
				const count = eraCounts.get(hit.name) ?? 0;
				const band = list.createDiv({ cls: "hl-era-band" });
				band.toggleClass("hl-era-empty", count === 0);
				band.createSpan({ cls: "hl-era-name", text: hit.name });
				band.createSpan({ cls: "hl-era-count", text: `(${count})` });
				band.createSpan({ cls: "hl-group-range", text: hit.range });
				anchors.push({ name: hit.name, range: hit.range, count, el: band });
			}
		};

		// Every grouped timeline keeps its full chronological skeleton, including
		// empty buckets. A lens supplies its era-system coverage; without one the
		// range runs from the first through the last visible event.
		const fill = grouped;
		const span = this.bar.groupBy === "decade" ? 10 : 100;
		let cursor: number | null = null;
		if (fill && system && system.boundaries.length)
			cursor = bucketKeyFor(system.boundaries[0].startKey, span);
		const emitEmpty = (upTo: number): void => {
			if (!fill || cursor === null) return;
			for (; cursor < upTo; cursor = nextBucketKey(cursor, span)) {
				emitBands(cursor);
				const h = list.createEl("h3", { cls: "hl-group hl-group-empty" });
				h.createSpan({ text: bucketLabelFor(cursor, span) });
			}
		};

		let lastGroup: string | null = null;
		for (const entry of visible) {
			const bucket = bucketKeyFor(entry.decoded.sortKey, span);
			if (cursor === null) cursor = bucket;
			emitEmpty(bucket);
			if (grouped) {
				const label = bucketLabelFor(bucket, span);
				if (label !== lastGroup) {
					const h = list.createEl("h3", { cls: "hl-group" });
					h.createSpan({ text: label });
					// Without a lens the section headings are the navigator's
					// table of contents.
					if (!system) anchors.push({ name: label, range: "", count: 0, el: h });
					lastGroup = label;
				}
			}
			if (cursor !== null && bucket >= cursor)
				cursor = nextBucketKey(bucket, span);
			if (!system && anchors.length) anchors[anchors.length - 1].count++;
			emitBands(entry.decoded.sortKey);
			this.renderCard(list, entry);
		}
		if (fill && system && system.boundaries.length) {
			const last = system.boundaries[system.boundaries.length - 1].startKey;
			const latest = visible.length
				? visible[visible.length - 1].decoded.sortKey
				: last;
			emitEmpty(nextBucketKey(bucketKeyFor(Math.max(last, latest), span), span));
		}
		emitBands(Infinity);
		this.trackCounts = [visible.length];
		this.eraAnchors = [anchors];
		this.renderEraNav();
	}

	private barHeight(): number {
		return this.barHost?.offsetHeight ?? 60;
	}

	// Floating era navigator: the active track's complete table of contents —
	// every era of its lens with its entry count, empty ones dimmed. Click one
	// to jump to where it starts (the band flashes), and the era under the
	// viewport top stays highlighted on scroll.
	private renderEraNav(): void {
		this.navEl?.remove();
		this.navEl = undefined;
		this.navItems = [];
		const anchors = this.eraAnchors[this.active] ?? [];
		if (!anchors.length || !this.listEl) return;
		// The wrap lives directly under the bar in the scroller root, outside
		// the (possibly centered) list column, so the panel hugs the pane's
		// visible corner in every layout.
		const wrap = createDiv({ cls: "hl-era-nav-wrap" });
		(this.barHost ?? this.contentEl).insertAdjacentElement("afterend", wrap);
		// The wrap tracks the pane's visible width (it can settle late, e.g.
		// right after a reload, and changes with the window and splits).
		const sizeWrap = () =>
			(wrap.style.width = `${this.contentEl.clientWidth}px`);
		sizeWrap();
		this.navSizer?.disconnect();
		this.navSizer = new ResizeObserver(sizeWrap);
		this.navSizer.observe(this.contentEl);
		this.navEl = wrap;
		const nav = wrap.createDiv({ cls: "hl-era-nav" });
		const title = nav.createEl("button", { cls: "hl-era-nav-title" });
		title.createSpan({
			cls: "hl-era-nav-title-text",
			text:
				this.tracks.length > 1
					? trackLabel(this.tracks[this.active], this.active)
					: "Periods",
		});
		const toggle = title.createSpan({ cls: "hl-era-nav-toggle" });
		const list = nav.createDiv({ cls: "hl-era-nav-list" });
		const paintCollapsed = (): void => {
			nav.toggleClass("is-collapsed", this.navCollapsed);
			title.setAttr("aria-expanded", String(!this.navCollapsed));
			title.setAttr(
				"aria-label",
				this.navCollapsed ? "Expand period navigator" : "Collapse period navigator"
			);
			setIcon(toggle, this.navCollapsed ? "chevron-down" : "chevron-up");
		};
		title.addEventListener("click", () => {
			this.navCollapsed = !this.navCollapsed;
			paintCollapsed();
		});
		for (const anchor of anchors) {
			const item = list.createDiv({ cls: "hl-era-nav-item" });
			item.toggleClass("hl-era-nav-empty", anchor.count === 0);
			item.createSpan({ text: `${anchor.name} (${anchor.count})` });
			if (anchor.range)
				item.createSpan({ cls: "hl-group-range", text: anchor.range });
			item.addEventListener("click", () => {
				// Land the band around a third of the way down the viewport — a
				// natural eye position, clear of the bar and sticky column heads.
				const box = this.contentEl.getBoundingClientRect();
				this.contentEl.scrollTop +=
					anchor.el.getBoundingClientRect().top -
					box.top -
					Math.max(this.barHeight() + 60, box.height * 0.3);
				anchor.el.addClass("hl-flash-band");
				window.setTimeout(() => anchor.el.removeClass("hl-flash-band"), 1300);
			});
			this.navItems.push({ anchor, el: item });
		}
		paintCollapsed();
		this.paintNavCurrent();
	}

	// Highlight the era the reader is actually looking at: take the active
	// track's topmost element around the reading line (a third down the
	// viewport) — an entry resolves through its year, an era band through its
	// name — so gaps and uncovered years clear the highlight instead of
	// leaving a stale one. Client-rect coordinates stay consistent under
	// Obsidian's zoom.
	private paintNavCurrent(): void {
		if (!this.navItems.length) return;
		const box = this.contentEl.getBoundingClientRect();
		const line = box.top + Math.max(this.barHeight() + 60, box.height * 0.35);
		const lens =
			this.tracks.length > 1 ? this.tracks[this.active].lens : this.bar.lens;
		const system = this.eraSystems.find((s) => s.name === lens) ?? null;

		// Base: the last section heading / era band above the reading line.
		let current: string | null = null;
		for (const { anchor } of this.navItems)
			if (anchor.el.getBoundingClientRect().top <= line) current = anchor.name;
		// With a lens, an entry sitting on the line is more precise than the
		// band positions: its year decides (and clears the highlight when the
		// system doesn't cover it).
		if (system) {
			for (const { key, el } of this.cardIndex) {
				if (this.tracks.length > 1) {
					const cell = el.closest("[data-track]");
					if (!cell || Number(cell.getAttr("data-track")) !== this.active)
						continue;
				}
				const r = el.getBoundingClientRect();
				if (r.bottom < line) continue;
				if (r.top <= line) current = eraAt(system, key)?.name ?? null;
				break;
			}
		}
		this.navItems.forEach(({ anchor, el }) =>
			el.toggleClass("hl-era-nav-current", current !== null && anchor.name === current)
		);
	}

	private renderCard(parent: HTMLElement, entry: TimelineEntry): void {
		if (this.bar.show !== "events") {
			const quizzes = this.quizzesForEntry(entry);
			const key = entry.evId ?? `${entry.filePath}:${entry.offset}`;
			const card = renderTimelineQuizCard(parent, entry, quizzes, {
				plugin: this.plugin,
				position: this.quizPositions.get(key) ?? 0,
				setPosition: (position) => this.quizPositions.set(key, position),
				update: async (quiz) => {
					await this.plugin.store.upsertQuiz(quiz);
					await this.refresh();
				},
			});
			this.cardEls.set(entry, card);
			this.cardIndex.push({ key: entry.decoded.sortKey, el: card });
			return;
		}
		const hasSummary = !!entry.summary?.trim();

		const card = parent.createDiv({ cls: "hl-card" });
		card.addClass(hasSummary ? "hl-has-summary" : "hl-no-summary");
		this.cardEls.set(entry, card);
		this.cardIndex.push({ key: entry.decoded.sortKey, el: card });

		const head = card.createDiv({ cls: "hl-card-head" });
		head.createSpan({ cls: "hl-year", text: describeYear(entry.decoded) });
		head.createSpan({ cls: "hl-tag", text: entry.tag });
		if (entry.evId) {
			const evId = entry.evId;
			const sym = head.createSpan({ cls: "hl-ev-symbol", text: EV_SYMBOL });
			sym.setAttr("aria-label", "Event actions");
			sym.addEventListener("click", (e) => {
				e.stopPropagation();
				openEvMenu(this.plugin, e, evId, entry.tag, tracksIn(entry.block));
			});
		}
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
			// Summary edits repaint just this card (live, on every autosave);
			// only binding a bare tag to a new event changes the vault structure
			// and needs a full rescan.
			void addEventForEntry(
				this.plugin,
				entry,
				() => this.refresh(),
				(evId, summary) => this.updateCardSummary(evId, summary)
			);
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
			? dbMarkersToHtml(entry.summary!, (id) => this.dbColors.get(id) ?? "")
			: line.replace(/\s+/g, " ").trim() || "*(no text)*";
		// Expanded: the full surrounding block, raw (images + every tag).
		const full = stripEvMarkers(entry.block).trim();

		const norm = (s: string) =>
			stripDbMarkers(stripTags(stripImages(s))).replace(/\s+/g, " ").trim();
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

	private entryMatchesShow(entry: TimelineEntry): boolean {
		if (this.bar.show === "events") return true;
		return this.quizzesForEntry(entry).length > 0;
	}

	private quizzesForEntry(entry: TimelineEntry): QuizEntry[] {
		if (!entry.evId) return [];
		return [...this.quizzes.values()].filter((quiz) => {
			if (quiz.sourceEvId !== entry.evId || quiz.status === "retired")
				return false;
			if (this.bar.show === "active-quizzes")
				return quiz.status === "active";
			if (this.bar.show === "mastered-quizzes")
				return quiz.status === "mastered";
			if (this.bar.show === "all-quizzes")
				return (
					quiz.status === "active" ||
					quiz.status === "paused" ||
					quiz.status === "mastered"
				);
			return false;
		});
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
			// The expanded block scrolls and selects freely (including its
			// scrollbar); fold back from the card head or the padding around it.
			if (expanded && t.closest(".hl-content.hl-context")) return;
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
		).then(() => this.wireDbRefs(content));
	}

	// Entity-type colors for the `{db …}` underlines in summaries.
	private dbColors = new Map<string, string>();

	private async loadDbColors(): Promise<void> {
		const [entities, types] = await Promise.all([
			this.plugin.store.readEntities(),
			this.plugin.store.readDbTypes(),
		]);
		const colorOf = new Map(types.map((t) => [t.name, t.color]));
		this.dbColors = new Map(
			[...entities.values()].map((e) => [e.id, colorOf.get(e.type) ?? ""])
		);
	}

	// Repaint one event's card after its summary changed — no vault rescan,
	// no list rebuild, so scroll, expansion and focus elsewhere are untouched.
	private updateCardSummary(evId: string, summary: string): void {
		const entry = this.entries.find((e) => e.evId === evId);
		const old = entry ? this.cardEls.get(entry) : undefined;
		if (!entry || !old) return;
		entry.summary = summary;
		this.cardIndex = this.cardIndex.filter((c) => c.el !== old);
		const tmp = createDiv();
		this.renderCard(tmp, entry);
		const fresh = tmp.firstElementChild;
		if (fresh) old.replaceWith(fresh);
		this.cardIndex.sort((a, b) => a.key - b.key);
	}

	// Folded `{db …}` markers render as underlined spans; click opens the entity.
	private wireDbRefs(content: HTMLElement): void {
		for (const el of Array.from(
			content.querySelectorAll<HTMLElement>("span.hl-db-ref")
		)) {
			const id = el.getAttr("data-db-id");
			if (!id) continue;
			el.setAttr("aria-label", "Open entity");
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.openEntity(id);
			});
		}
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

	// Scroll to the card of a specific event (by ev id, falling back to the
	// bare tag) — the ⌛ menu's "Show on timeline" landing.
	async focusEvent(evId: string, tag: string): Promise<void> {
		if (!this.entries.length) await this.refresh();
		const target =
			this.entries.find((e) => e.evId === evId) ??
			this.entries.find((e) => e.tag === tag);
		if (!target) {
			new Notice("Event not found on the timeline.");
			return;
		}
		this.scrollToEntry(target);
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

	onResize(): void {
		if (this.navEl) this.navEl.style.width = `${this.contentEl.clientWidth}px`;
	}

	private onScroll(): void {
		this.paintNavCurrent();
	}
}
