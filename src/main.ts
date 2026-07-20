import {
	Editor,
	FuzzySuggestModal,
	Notice,
	normalizePath,
	Plugin,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	HistoryLoggingSettings,
	HistoryLoggingSettingTab,
} from "./settings";
import { DataStore } from "./data-store";
import { createLivePreviewExtension } from "./live-preview";
import { jumpFlashField } from "./jump-flash";
import { createReadingProcessor } from "./reading-view";
import { addEventAtCursor } from "./commands";
import {
	createTagClickExtension,
	registerTagContextMenu,
} from "./tag-click";
import { registerMapEditorMenu } from "./map-editor-menu";
import { registerNoteImageResize } from "./image-resize";
import { SummaryModal } from "./summary-modal";
import { TIMELINE_VIEW_TYPE, TimelineView } from "./timeline-view";
import { ERA_MANAGER_VIEW_TYPE, EraManagerView } from "./era-manager-view";
import { LayoutPane, TimelineLayout } from "./layouts";
import { NameModal } from "./name-modal";
import { EntitySuggestModal } from "./entity-modal";
import { checkDataHealth } from "./health-check";
import { ENTITY_VIEW_TYPE, EntityView } from "./entity-view";
import {
	ENTITY_BROWSER_VIEW_TYPE,
	EntityBrowserView,
} from "./entity-browser-view";
import {
	RECITATION_VIEW_TYPE,
	RecitationView,
} from "./recitation-view";
import { LEXICON_VIEW_TYPE, LexiconView } from "./lexicon-view";
import { QuizManagerModal, QuizPracticeModal } from "./quiz-modal";
import { MapOcclusionEditor } from "./map-viewer";
import { QuizEntry } from "./quiz";
import { quizSchedule } from "./quiz-display";
import { ModalStash } from "./modal-stash";
import { setDisplayLangOrder } from "./db-format";
import { QuizReminderModal } from "./quiz-reminder";
import { ReciteReminderModal } from "./recite-reminder";
import { ReciteProgress, keyOf } from "./recite-progress";
import {
	DbVaultCache,
	VaultDbSuggest,
	createVaultDbExtension,
	createVaultDbProcessor,
	openDbSelectionMenu,
} from "./vault-db";

export default class HistoryLoggingPlugin extends Plugin {
	settings!: HistoryLoggingSettings;
	store!: DataStore;
	modalStash!: ModalStash;
	dbVault = new DbVaultCache(this);
	private quizReminders = new Map<string, number>();
	private reminderModal: QuizReminderModal | null = null;
	private reciteReminders = new Map<string, number>();
	private reciteReminderModal: ReciteReminderModal | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyFontScales();
		this.store = new DataStore(this.app, () => this.settings.dataFolder);
		this.modalStash = new ModalStash(this);

		this.registerEditorExtension(createLivePreviewExtension(this));
		this.registerEditorExtension(jumpFlashField);
		this.registerEditorExtension(createTagClickExtension(this));
		this.registerEditorExtension(createVaultDbExtension(this));
		this.registerMarkdownPostProcessor(createReadingProcessor(this));
		this.registerMarkdownPostProcessor(createVaultDbProcessor(this));
		this.registerEditorSuggest(new VaultDbSuggest(this));

		// Entity references in ordinary notes need synchronous access to the
		// entity list and type colors; keep a cache fresh off the data files.
		this.app.workspace.onLayoutReady(() => void this.dbVault.refresh());
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (
					f instanceof TFile &&
					f.path.startsWith(this.settings.dataFolder + "/")
				)
					void this.dbVault.refresh();
			})
		);
		registerTagContextMenu(this);
		registerMapEditorMenu(this);
		registerNoteImageResize(this);
		this.addSettingTab(new HistoryLoggingSettingTab(this.app, this));

		this.registerView(
			TIMELINE_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new TimelineView(leaf, this)
		);
		this.registerView(
			ERA_MANAGER_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new EraManagerView(leaf, this)
		);
		this.registerView(
			ENTITY_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new EntityView(leaf, this)
		);
		this.registerView(
			ENTITY_BROWSER_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new EntityBrowserView(leaf, this)
		);
		this.registerView(
			RECITATION_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new RecitationView(leaf, this)
		);
		this.registerView(
			LEXICON_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new LexiconView(leaf, this)
		);

		// Open views cache file paths from the last scan; a rename would leave
		// their jump-to-source stale until the next manual refresh.
		this.registerEvent(
			this.app.vault.on("rename", () => void this.refreshTimelines())
		);
		this.addRibbonIcon("history", "Open history timeline", () =>
			this.activateTimeline("tab")
		);
		this.addRibbonIcon("library", "Open entity browser", () =>
			void this.browseEntities()
		);
		this.addRibbonIcon("brain-circuit", "打开背诵", () =>
			void this.openRecitation()
		);
		this.addRibbonIcon("book-a", "打开词汇", () =>
			void this.openLexicon()
		);

		this.addCommand({
			id: "add-event-at-cursor",
			name: "Add event to year tag under cursor",
			editorCallback: (editor: Editor) => addEventAtCursor(this, editor),
		});
		this.addCommand({
			id: "db-selection-menu",
			name: "词条：标注选中文本（选区菜单）",
			editorCallback: (editor: Editor, ctx) =>
				openDbSelectionMenu(this, editor, ctx.file?.path),
		});
		this.addCommand({
			id: "open-timeline",
			name: "Open history timeline",
			callback: () => this.activateTimeline("tab"),
		});
		this.addCommand({
			id: "open-timeline-new-pane",
			name: "Open another timeline (split pane)",
			callback: () => void this.openTimelineSplit(),
		});
		this.addCommand({
			id: "open-timeline-sidebar",
			name: "Open history timeline in sidebar",
			callback: () => this.activateTimeline("sidebar"),
		});
		this.addCommand({
			id: "save-timeline-layout",
			name: "Save timeline layout (this view's tracks)",
			callback: () => this.saveLayoutInteractive(),
		});
		this.addCommand({
			id: "open-timeline-layout",
			name: "Open saved timeline layout",
			callback: () => void this.openLayoutInteractive(),
		});
		this.addCommand({
			id: "manage-era-systems",
			name: "Manage era systems",
			callback: () => void this.openEraManager(),
		});
		this.addCommand({
			id: "browse-entities",
			name: "Browse entities",
			callback: () => void this.browseEntities(),
		});
		this.addCommand({
			id: "search-entities",
			name: "Search entities (quick jump)",
			callback: () => void this.searchEntities(),
		});
		this.addCommand({
			id: "manage-entity-types",
			name: "Manage entity types",
			callback: () => void this.browseEntities("types"),
		});
		this.addCommand({
			id: "browse-quizzes",
			name: "Browse quizzes",
			callback: () => void this.browseEntities("quizzes"),
		});
		this.addCommand({
			id: "open-recitation",
			name: "打开背诵",
			callback: () => void this.openRecitation(),
		});
		this.addCommand({
			id: "open-lexicon",
			name: "打开词汇",
			callback: () => void this.openLexicon(),
		});
		this.addCommand({
			id: "check-data-health",
			name: "Check data health",
			callback: () => void checkDataHealth(this),
		});
		this.addCommand({
			id: "toggle-db-mask-mode",
			name: "切换词条遮挡模式",
			callback: () => {
				this.settings.dbMaskMode = !this.settings.dbMaskMode;
				void this.saveSettings();
				new Notice(
					this.settings.dbMaskMode
						? "词条遮挡模式：开"
						: "词条遮挡模式：关"
				);
				void this.refreshTimelines();
			},
		});
	}

	// Per-surface UI font scaling, driven by CSS variables on the body.
	applyFontScales(): void {
		const set = (name: string, pct: number) =>
			document.body.style.setProperty(
				name,
				`${Math.min(150, Math.max(80, pct)) / 100}`
			);
		set("--hl-scale-player", this.settings.fontScalePlayer);
		set("--hl-scale-modals", this.settings.fontScaleModals);
		set("--hl-scale-lists", this.settings.fontScaleLists);
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(TIMELINE_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(ERA_MANAGER_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(ENTITY_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(ENTITY_BROWSER_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(RECITATION_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(LEXICON_VIEW_TYPE);
		for (const name of [
			"--hl-scale-player",
			"--hl-scale-modals",
			"--hl-scale-lists",
		])
			document.body.style.removeProperty(name);
	}

	// Open (or focus) the recitation hub tab.
	async openRecitation(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(RECITATION_VIEW_TYPE)[0];
		if (existing) {
			workspace.revealLeaf(existing);
			if (existing.view instanceof RecitationView)
				await existing.view.reload();
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: RECITATION_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	// Open (or focus) the lexicon workbench tab.
	async openLexicon(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(LEXICON_VIEW_TYPE)[0];
		if (existing) {
			workspace.revealLeaf(existing);
			if (existing.view instanceof LexiconView)
				await existing.view.reload();
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: LEXICON_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	// Open the timeline either as a full main-pane tab (default) or a narrow
	// sidebar quick-peek. Reuses an existing leaf of the same kind if present.
	async activateTimeline(where: "tab" | "sidebar" = "tab"): Promise<void> {
		const { workspace } = this.app;
		const wantSidebar = where === "sidebar";
		const existing = workspace
			.getLeavesOfType(TIMELINE_VIEW_TYPE)
			.find((l) => (l.getRoot() === workspace.rightSplit) === wantSidebar);
		if (existing) {
			workspace.revealLeaf(existing);
			return;
		}
		const leaf = wantSidebar
			? workspace.getRightLeaf(false)
			: workspace.getLeaf("tab");
		if (!leaf) return;
		await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	// Always open a fresh timeline pane in a vertical split — each pane keeps
	// its own profile/query/era-system, so parallel comparison is just several
	// panes side by side.
	async openTimelineSplit(): Promise<void> {
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	// Snapshot the active timeline's tracks under a name in layouts.md — a
	// whole comparison grid (N tracks, one view) becomes one reopenable unit.
	saveLayoutInteractive(): void {
		const view = this.activeTimeline();
		if (!view) {
			new Notice("No timeline is open.");
			return;
		}
		const state = view.getState();
		const groupBy = typeof state.groupBy === "string" ? state.groupBy : "century";
		const panes: LayoutPane[] = view.getTracks().map((t) => ({
			filter: t.filter,
			lens: t.lens,
			profile: t.profile,
			groupBy,
		}));
		const show = view.getShow();
		new NameModal(this.app, "Save layout as", "", (name) => {
			void (async () => {
				const layouts = await this.store.readLayouts();
				const rest = layouts.filter((l) => l.name !== name);
				await this.store.writeLayouts([...rest, { name, show, panes }]);
				new Notice(`Layout "${name}" saved (${panes.length} tracks).`);
			})();
		}).open();
	}

	async openLayoutInteractive(): Promise<void> {
		const layouts = await this.store.readLayouts();
		if (!layouts.length) {
			new Notice("No saved layouts. Save one first.");
			return;
		}
		new LayoutSuggestModal(this, layouts).open();
	}

	private activeTimeline(): TimelineView | null {
		const active = this.app.workspace.getActiveViewOfType(TimelineView);
		if (active) return active;
		for (const leaf of this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)) {
			if (leaf.view instanceof TimelineView) return leaf.view;
		}
		return null;
	}

	// Open a layout as ONE timeline tab whose columns are the saved tracks —
	// the comparison lives inside a single view, not across split panes.
	async applyLayout(layout: TimelineLayout): Promise<TimelineView | null> {
		const { workspace } = this.app;
		const tracks = layout.panes.map((p) => ({
			filter: p.filter,
			lens: p.lens,
			profile: p.profile,
		}));
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: TIMELINE_VIEW_TYPE,
			active: true,
			state: {
				tracks,
				active: 0,
				groupBy: layout.panes[0]?.groupBy ?? "century",
				show: layout.show,
			},
		});
		workspace.revealLeaf(leaf);
		return leaf.view instanceof TimelineView ? leaf.view : null;
	}

	// "Show with layout …": open a saved layout and try to land on the event.
	// If the layout's filters hide it, focusEvent notices the reader.
	async revealOnLayout(
		layout: TimelineLayout,
		id: string,
		tag: string
	): Promise<void> {
		const view = await this.applyLayout(layout);
		if (view) await view.focusEvent(id, tag);
	}

	// Open the era-system manager as a main-pane tab (reuse if already open).
	async openEraManager(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(ERA_MANAGER_VIEW_TYPE)[0];
		if (existing) {
			workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: ERA_MANAGER_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	// Rescan every open timeline so era-system edits show up immediately.
	async refreshTimelines(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TimelineView) await view.refresh();
		}
	}

	openSummary(
		id: string,
		tag: string,
		onSaved?: (summary: string) => void,
		ensure?: () => Promise<boolean>
	): void {
		new SummaryModal(this.app, this, id, tag, onSaved, ensure).open();
	}

	openQuizManager(
		id: string,
		tag: string,
		clozeAnswer = "",
		ensure?: () => Promise<boolean>,
		editQuizId = ""
	): void {
		new QuizManagerModal(
			this.app,
			this,
			id,
			tag,
			clozeAnswer,
			ensure,
			editQuizId
		).open();
	}

	// Open the full map viewer (occlusion review / marking) for a maps.md
	// entry.
	async openMapViewer(
		id: string,
		onChanged?: () => void,
		focusOcclusionId?: string
	): Promise<void> {
		const map = (await this.store.readMaps()).get(id);
		if (!map) return;
		new MapOcclusionEditor(
			this.app,
			this,
			map,
			onChanged,
			focusOcclusionId
		).open();
	}

	// ⌛ menu: open (or focus) a timeline and scroll to this event's card.
	// Navigation always lands on a plain single-track unfiltered timeline —
	// never a curated multi-track layout tab — so the target is always there
	// and the reader's comparison layouts stay untouched.
	async revealOnTimeline(id: string, tag: string): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(TIMELINE_VIEW_TYPE).find((l) => {
			if (l.getRoot() === workspace.rightSplit) return false;
			return l.view instanceof TimelineView && l.view.isPlainView();
		});
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof TimelineView) await view.focusEvent(id, tag);
	}

	// Deck-aware variant used by the recitation hub: land on a timeline
	// showing the deck's profile with the quiz filter set to all, so the
	// target's quiz cards are guaranteed visible.
	async revealOnTimelineForProfile(
		profileName: string,
		id: string,
		tag: string
	): Promise<void> {
		const profile = (await this.store.readProfiles()).find(
			(p) => p.name === profileName
		);
		if (!profile) {
			await this.revealOnTimeline(id, tag);
			return;
		}
		const { workspace } = this.app;
		const leaves = workspace
			.getLeavesOfType(TIMELINE_VIEW_TYPE)
			.filter((l) => l.getRoot() !== workspace.rightSplit);
		let leaf = leaves.find(
			(l) =>
				l.view instanceof TimelineView &&
				l.view.getProfileName() === profile.name
		);
		if (!leaf)
			leaf = leaves.find(
				(l) => l.view instanceof TimelineView && l.view.isPlainView()
			);
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof TimelineView)
			await view.focusEventWithProfile(profile, id, tag);
	}

	async openEntity(id: string): Promise<void> {
		await this.openEntityView(id);
	}

	// Open (or focus) the full entity tab page for an id.
	async openEntityView(id: string): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace
			.getLeavesOfType(ENTITY_VIEW_TYPE)
			.find(
				(l) =>
					l.view instanceof EntityView &&
					(l.view.getState() as { entityId?: string }).entityId === id
			);
		if (existing) {
			workspace.revealLeaf(existing);
			if (existing.view instanceof EntityView) await existing.view.refresh();
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: ENTITY_VIEW_TYPE,
			active: true,
			state: { entityId: id },
		});
		workspace.revealLeaf(leaf);
	}

	// Open (or focus) the backstage tab, optionally landing on a section.
	async browseEntities(
		section?: "entities" | "types" | "quizzes" | "maps"
	): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(ENTITY_BROWSER_VIEW_TYPE)[0];
		if (existing) {
			workspace.revealLeaf(existing);
			if (existing.view instanceof EntityBrowserView) {
				await existing.view.reload();
				if (section) existing.view.showSection(section);
			}
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: ENTITY_BROWSER_VIEW_TYPE,
			active: true,
		});
		workspace.revealLeaf(leaf);
		if (section && leaf.view instanceof EntityBrowserView)
			leaf.view.showSection(section);
	}

	// Quick fuzzy jump straight to one entity's page.
	async searchEntities(): Promise<void> {
		const entities = [...(await this.store.readEntities()).values()];
		if (!entities.length) {
			new Notice(
				"No entities yet. Select text in an event summary and right-click to create one."
			);
			return;
		}
		new EntitySuggestModal(this.app, entities, (e) => {
			void this.openEntityView(e.id);
		}).open();
	}

	// After a short wait (forgot retry or first-learn recheck), surface the
	// quiz again with an alarm-style reminder modal (or a persistent notice
	// while another modal is in the way). Day-scale intervals are picked up
	// on the next visit instead.
	remindQuizWhenReady(quiz: QuizEntry): void {
		const pending = this.quizReminders.get(quiz.id);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.quizReminders.delete(quiz.id);
		}
		if (quiz.status !== "active" || !quiz.nextReview) return;
		const due = Date.parse(quiz.nextReview);
		if (Number.isNaN(due)) return;
		const delay = due - Date.now();
		const schedule = quizSchedule(this.settings);
		const horizon =
			Math.max(0, schedule.retryMinutes, schedule.recheckMinutes) * 60_000;
		if (delay <= 0 || delay > horizon) return;
		const timer = window.setTimeout(() => {
			this.quizReminders.delete(quiz.id);
			this.surfaceQuizReminder(quiz.id);
			void this.refreshTimelines();
		}, delay);
		this.quizReminders.set(quiz.id, timer);
		this.register(() => {
			const active = this.quizReminders.get(quiz.id);
			if (active === timer) {
				window.clearTimeout(timer);
				this.quizReminders.delete(quiz.id);
			}
		});
	}

	// One reminder window at a time: quizzes due while it is open join its
	// queue; if another modal is in the way, fall back to a persistent notice
	// that opens the reminder on click.
	private surfaceQuizReminder(quizId: string): void {
		void this.routeQuizReminder(quizId);
	}

	// When the recitation hub is the active view the user is already inside
	// the practice surface: the due card joins the running session (or the
	// wall's badges light up) instead of a popup.
	private async routeQuizReminder(quizId: string): Promise<void> {
		const active =
			this.app.workspace.getActiveViewOfType(RecitationView);
		if (active) {
			const quiz = (await this.store.readQuizzes()).get(quizId);
			if (quiz && active.handleDueQuiz(quiz)) return;
		}
		this.popQuizReminder(quizId);
	}

	private popQuizReminder(quizId: string): void {
		if (this.reminderModal) {
			this.reminderModal.enqueue(quizId);
			return;
		}
		const openReminder = (): void => {
			if (this.reminderModal) {
				this.reminderModal.enqueue(quizId);
				return;
			}
			const modal = new QuizReminderModal(this.app, this, quizId, () => {
				if (this.reminderModal === modal) this.reminderModal = null;
			});
			this.reminderModal = modal;
			modal.open();
		};
		if (this.modalStash.hasOpen()) {
			const notice = new Notice("⏰ 有 Quiz 到了重温时间，点击开始。", 0);
			notice.noticeEl.addEventListener("click", () => {
				notice.hide();
				openReminder();
			});
			return;
		}
		openReminder();
	}

	// Same alarm pipeline for lexicon directions coming off a short wait:
	// the timer fires on due, the lexicon tab consumes it when active,
	// otherwise a light reminder card pops up (or a persistent notice while
	// another modal is in the way). Day-scale intervals never pop.
	remindReciteWhenReady(rec: ReciteProgress): void {
		const key = keyOf(rec);
		const pending = this.reciteReminders.get(key);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.reciteReminders.delete(key);
		}
		// A language never quizzes itself: from→from is not a direction.
		if (rec.from === rec.to) return;
		if (rec.status !== "active" || !rec.nextReview) return;
		const due = Date.parse(rec.nextReview);
		if (Number.isNaN(due)) return;
		const delay = due - Date.now();
		const schedule = quizSchedule(this.settings);
		const horizon =
			Math.max(0, schedule.retryMinutes, schedule.recheckMinutes) * 60_000;
		if (delay <= 0 || delay > horizon) return;
		const timer = window.setTimeout(() => {
			this.reciteReminders.delete(key);
			this.routeReciteReminder(key);
		}, delay);
		this.reciteReminders.set(key, timer);
		this.register(() => {
			const active = this.reciteReminders.get(key);
			if (active === timer) {
				window.clearTimeout(timer);
				this.reciteReminders.delete(key);
			}
		});
	}

	// When the lexicon tab is the active view the user is already inside the
	// practice surface: a running session interjects the card, the workbench
	// refreshes its badges — no popup either way.
	private routeReciteReminder(key: string): void {
		const active = this.app.workspace.getActiveViewOfType(LexiconView);
		if (active && active.handleDueDirection(key)) return;
		this.popReciteReminder(key);
	}

	private popReciteReminder(key: string): void {
		if (this.reciteReminderModal) {
			this.reciteReminderModal.enqueue(key);
			return;
		}
		const openReminder = (): void => {
			if (this.reciteReminderModal) {
				this.reciteReminderModal.enqueue(key);
				return;
			}
			const modal = new ReciteReminderModal(this.app, this, key, () => {
				if (this.reciteReminderModal === modal)
					this.reciteReminderModal = null;
			});
			this.reciteReminderModal = modal;
			modal.open();
		};
		if (this.modalStash.hasOpen()) {
			const notice = new Notice("⏰ 有词条到了重温时间，点击开始。", 0);
			notice.noticeEl.addEventListener("click", () => {
				notice.hide();
				openReminder();
			});
			return;
		}
		openReminder();
	}

	// Settings live in `<dataFolder>/settings.json` inside the vault so they
	// sync with it (`.obsidian` may be excluded from sync). The plugin-folder
	// data.json is kept as a device-local fallback and migration source.
	async loadSettings(): Promise<void> {
		const legacy = (await this.loadData()) as
			| Partial<HistoryLoggingSettings>
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, legacy);
		const adapter = this.app.vault.adapter;
		const folders = [
			...new Set([this.settings.dataFolder, DEFAULT_SETTINGS.dataFolder]),
		];
		for (const folder of folders) {
			const path = normalizePath(`${folder}/settings.json`);
			if (!(await adapter.exists(path))) continue;
			try {
				const parsed = JSON.parse(
					await adapter.read(path)
				) as Partial<HistoryLoggingSettings>;
				this.settings = Object.assign(
					{},
					DEFAULT_SETTINGS,
					legacy,
					parsed
				);
			} catch (err) {
				console.error("history-logging: bad settings.json", err);
			}
			break;
		}
		this.migrateQuizSchedule();
		setDisplayLangOrder(this.settings.entityLangs);
	}

	// The old minute-scale defaults ([10, 1440] with a 5-minute retry) treated
	// the 10-minute recheck as a mastery step; move them to day-scale steps.
	private migrateQuizSchedule(): void {
		const intervals = this.settings.quizIntervalsMinutes;
		if (
			intervals.length === 2 &&
			intervals[0] === 10 &&
			intervals[1] === 24 * 60
		) {
			this.settings.quizIntervalsMinutes = [
				...DEFAULT_SETTINGS.quizIntervalsMinutes,
			];
			if (this.settings.quizRetryMinutes === 5)
				this.settings.quizRetryMinutes =
					DEFAULT_SETTINGS.quizRetryMinutes;
		}
	}

	async saveSettings(): Promise<void> {
		setDisplayLangOrder(this.settings.entityLangs);
		await this.saveData(this.settings);
		const adapter = this.app.vault.adapter;
		const folder = normalizePath(this.settings.dataFolder);
		if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
		await adapter.write(
			normalizePath(`${folder}/settings.json`),
			JSON.stringify(this.settings, null, 2)
		);
	}
}

class LayoutSuggestModal extends FuzzySuggestModal<TimelineLayout> {
	constructor(
		private plugin: HistoryLoggingPlugin,
		private layouts: TimelineLayout[]
	) {
		super(plugin.app);
		this.setPlaceholder("Open saved timeline layout…");
	}

	getItems(): TimelineLayout[] {
		return this.layouts;
	}

	getItemText(l: TimelineLayout): string {
		return `${l.name} (${l.panes.length} tracks)`;
	}

	onChooseItem(l: TimelineLayout): void {
		void this.plugin.applyLayout(l);
	}
}
