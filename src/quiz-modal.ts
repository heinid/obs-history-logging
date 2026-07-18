import {
	App,
	MarkdownRenderer,
	Modal,
	Notice,
	setIcon,
} from "obsidian";
import { DbType, EntityEntry } from "./db-format";
import { EntityModal } from "./entity-modal";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import {
	QuizEntry,
	QuizKind,
	QuizResult,
	QuizSchedule,
	isQuizReady,
	reviewQuiz,
	reviveQuiz,
} from "./quiz";
import {
	clozeRevealsInline,
	nextReviewLabel,
	quizAnswer,
	quizQuestion,
	quizSchedule,
	rateNotice,
} from "./quiz-display";
import { generateId } from "./id";
import { ConfirmModal } from "./name-modal";
import { describeYear, parseYearTag } from "./year-tag";
import { makeClozeMarked, stripDbMarkers } from "./db-marker";
import { DbColors, loadDbColors, renderQuizText } from "./quiz-render";
import { attachAnnotateMenu } from "./textarea-annotate";
import { renderMapExamHeader, renderMapExamStage } from "./map-occlusion";

export class QuizManagerModal extends Modal {
	private event?: EventEntry;
	private quizzes = new Map<string, QuizEntry>();
	private eventQuizzes: QuizEntry[] = [];
	private dbColors: DbColors = new Map();
	private ensured: boolean;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private evId: string,
		private tag: string,
		private clozeAnswer = "",
		private ensure?: () => Promise<boolean>,
		private editQuizId = ""
	) {
		super(app);
		this.ensured = !ensure;
	}

	async onOpen(): Promise<void> {
		this.plugin.modalStash.track(this);
		await this.reload();
		const editQuiz = this.editQuizId
			? this.eventQuizzes.find((quiz) => quiz.id === this.editQuizId)
			: undefined;
		if (editQuiz) {
			this.modalEl.hide();
			this.openEditor(editQuiz, "qa", true);
			return;
		}
		if (!this.eventQuizzes.length || this.clozeAnswer) {
			this.modalEl.hide();
			this.openEditor(undefined, this.clozeAnswer ? "cloze" : "year");
			return;
		}
		this.renderManager();
	}

	private async reload(): Promise<void> {
		const [event, quizzes, colors] = await Promise.all([
			this.plugin.store.getEvent(this.evId),
			this.plugin.store.readQuizzes(),
			loadDbColors(this.plugin),
		]);
		this.dbColors = colors;
		this.event = {
			id: this.evId,
			tag: this.tag,
			summary: event?.summary ?? "",
			updated: event?.updated,
		};
		this.quizzes = quizzes;
		this.eventQuizzes = [...this.quizzes.values()]
			.filter((quiz) => quiz.sourceEvId === this.evId)
			.sort((a, b) => a.created.localeCompare(b.created));
	}

	private renderManager(): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-quiz-modal");
		renderQuizModalHead(host, this.tag, `Quiz（${this.eventQuizzes.length}）`);

		const list = host.createDiv({ cls: "hl-quiz-manage-list" });
		const schedule = quizSchedule(this.plugin.settings);
		for (const quiz of this.eventQuizzes) {
			const reviewLabel = nextReviewLabel(quiz, new Date(), schedule);
			const row = list.createDiv({ cls: "hl-quiz-manage-row" });
			const main = row.createDiv({ cls: "hl-quiz-manage-main" });
			main.createDiv({
				cls: "hl-quiz-kind",
				text: quizKindLabel(quiz.kind),
			});
			const question = main.createDiv({ cls: "hl-quiz-manage-question" });
			renderQuizText(
				this.plugin,
				quizQuestion(quiz, this.event),
				question,
				this.dbColors
			);
			main.createDiv({
				cls: "hl-quiz-manage-meta",
				text: `${
					quiz.status === "mastered" ? "学过" : "在学"
				} · 掌握 ${quiz.progress}/${
					this.plugin.settings.quizMasterySteps
				}${reviewLabel ? ` · ${reviewLabel}` : ""}`,
			});

			const practice = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(practice, "brain");
			practice.setAttr("aria-label", "练习");
			practice.disabled = quiz.status !== "active";
			practice.addEventListener("click", () => {
				new QuizPracticeModal(this.app, this.plugin, quiz.id, () =>
					void this.refreshManager()
				).open();
			});

			const edit = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(edit, "pencil");
			edit.setAttr("aria-label", "编辑这个 Quiz");
			edit.addEventListener("click", () => this.openEditor(quiz));

			const more = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(more, "more-horizontal");
			more.setAttr("aria-label", "更多 Quiz 操作");
			more.addEventListener("click", () => {
				const actions = row.createDiv({ cls: "hl-quiz-inline-actions" });
				more.remove();
				if (quiz.status === "mastered")
					this.actionButton(actions, "重新学习", () =>
						this.changeQuiz(reviveQuiz(quiz))
					);
				this.actionButton(actions, "删除", () => this.confirmDelete(quiz));
			});
		}

		const foot = host.createDiv({ cls: "hl-modal-foot hl-quiz-manager-foot" });
		const add = foot.createEl("button", {
			cls: "mod-cta",
			text: "New Quiz",
		});
		add.addEventListener("click", () => this.openEditor(undefined, "year"));
	}

	private openEditor(
		existing?: QuizEntry,
		initialKind: QuizKind = "qa",
		standalone = false
	): void {
		new QuizEditorModal(this.app, this.plugin, {
			event: this.event ?? { id: this.evId, tag: this.tag, summary: "" },
			tag: this.tag,
			quizIds: new Set(this.quizzes.keys()),
			existing,
			initialKind,
			clozeAnswer: existing ? "" : this.clozeAnswer,
			ensure: async () => {
				if (this.ensured) return true;
				if (!(await this.ensure!())) return false;
				this.ensured = true;
				return true;
			},
			onSaved: standalone ? () => this.close() : () => void this.refreshManager(),
			onClosed: standalone ? () => this.close() : () => void this.refreshManager(),
		}).open();
	}

	// Refresh data in place after coming back from a stashed entity-page
	// jump (the modal stays where it was, hidden or shown).
	async onStashRestore(): Promise<void> {
		await this.reload();
		if (this.modalEl.isShown()) this.renderManager();
	}

	private async refreshManager(): Promise<void> {
		await this.reload();
		if (!this.eventQuizzes.length) {
			this.close();
			return;
		}
		this.modalEl.show();
		this.renderManager();
	}

	private actionButton(
		host: HTMLElement,
		label: string,
		action: () => void
	): void {
		const button = host.createEl("button", { text: label });
		button.addEventListener("click", action);
	}

	private changeQuiz(quiz: QuizEntry): void {
		void (async () => {
			await this.plugin.store.upsertQuiz(quiz);
			await this.plugin.refreshTimelines();
			await this.reload();
			this.renderManager();
		})();
	}

	private confirmDelete(quiz: QuizEntry): void {
		new ConfirmModal(
			this.app,
			"删除 Quiz",
			"删除这个 Quiz 及其全部练习记录？",
			"删除",
			() =>
				void (async () => {
					await this.plugin.store.removeQuiz(quiz.id);
					await this.plugin.refreshTimelines();
					await this.refreshManager();
				})()
		).open();
	}

	onClose(): void {
		this.plugin.modalStash.untrack(this);
		this.contentEl.empty();
	}
}

interface QuizEditorOptions {
	event: EventEntry;
	tag: string;
	quizIds: Set<string>;
	existing?: QuizEntry;
	initialKind: QuizKind;
	clozeAnswer: string;
	ensure: () => Promise<boolean>;
	onSaved: () => void;
	onClosed: () => void;
}

export class QuizEditorModal extends Modal {
	private entities: EntityEntry[] = [];
	private types: DbType[] = [];

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private opts: QuizEditorOptions
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.plugin.modalStash.track(this);
		this.entities = [
			...(await this.plugin.store.readEntities()).values(),
		];
		this.types = await this.plugin.store.readDbTypes();
		this.render();
	}

	// Only refresh the entity/type lists — re-rendering would discard any
	// text the user has typed into the editor.
	async onStashRestore(): Promise<void> {
		this.entities = [
			...(await this.plugin.store.readEntities()).values(),
		];
		this.types = await this.plugin.store.readDbTypes();
	}

	private typeColor(name: string): string | null {
		return this.types.find((t) => t.name === name)?.color ?? null;
	}

	// Right-click on selected text in the quiz fields: create or link an
	// entity, replacing the selection with a `{db id text}` marker.
	private wireAnnotate(area: HTMLTextAreaElement): void {
		attachAnnotateMenu(area, {
			entities: () => this.entities,
			typeColor: (name) => this.typeColor(name),
			onCreate: (word, apply) => {
				const entity: EntityEntry = {
					id: generateId((id) =>
						this.entities.some((e) => e.id === id)
					),
					type: "",
					labels: [
						{
							lang: this.plugin.settings.entityLangs[0] ?? "zh",
							text: word,
						},
					],
					readings: [],
					audios: [],
					tags: [],
					body: "",
				};
				new EntityModal(this.app, this.plugin, entity, true, (saved) => {
					this.entities.push(saved);
					apply(saved);
				}).open();
			},
		});
	}

	private render(): void {
		const host = this.contentEl;
		const existing = this.opts.existing;
		host.empty();
		host.addClass("hl-quiz-modal");
		host.addClass("hl-quiz-editor");

		let kind = existing?.kind ?? this.opts.initialKind;
		renderQuizModalHead(
			host,
			this.opts.tag,
			existing ? `Edit ${quizKindLabel(kind)}` : "New Quiz"
		);
		const kinds: [QuizKind, string][] = [
			["year", "Year"],
			["cloze", "Cloze"],
			["qa", "Q&A"],
		];
		const tabEls = new Map<QuizKind, HTMLElement>();
		if (!existing) {
			const tabs = host.createDiv({ cls: "hl-quiz-kind-tabs" });
			for (const [value, label] of kinds) {
				const tab = tabs.createSpan({ cls: "hl-quiz-kind-tab", text: label });
				tabEls.set(value, tab);
				tab.addEventListener("click", () => {
					// The year prefill (event summary) must not leak into
					// the other kinds when the user has not edited it.
					if (kind === "year" && value !== "year" && question === rawSummary)
						question = "";
					if (value === "year" && !question) question = rawSummary;
					kind = value;
					paintForm();
				});
			}
		}
		const form = host.createDiv({ cls: "hl-quiz-form" });

		let question = existing?.question ?? "";
		let answer = existing?.answer ?? "";
		let hint = existing?.hint ?? "";
		// The question keeps the raw summary (with `{db …}` markers) so entity
		// references survive into the card; the cloze source shows the folded
		// display text, and makeClozeMarked maps the selection range back.
		const rawSummary = this.opts.event.summary ?? "";
		const summary = stripDbMarkers(rawSummary);
		if (!existing && kind === "year") question = rawSummary;
		if (!existing && kind === "cloze" && this.opts.clozeAnswer) {
			const at = summary.indexOf(this.opts.clozeAnswer);
			if (at >= 0)
				({ question, answer } = makeClozeMarked(
					rawSummary,
					at,
					at + this.opts.clozeAnswer.length
				));
			else answer = this.opts.clozeAnswer;
		}

		const textArea = (
			parent: HTMLElement,
			label: string,
			value: string,
			placeholder: string,
			onInput: (next: string) => void
		): HTMLTextAreaElement => {
			parent.createDiv({ cls: "hl-quiz-field-label", text: label });
			const area = parent.createEl("textarea", {
				cls: "hl-quiz-textarea",
				placeholder,
			});
			area.value = value;
			area.addEventListener("input", () => onInput(area.value));
			this.wireAnnotate(area);
			return area;
		};

		const paintForm = (): void => {
			form.empty();
			for (const [value] of kinds)
				tabEls.get(value)?.toggleClass("is-active", value === kind);

			if (kind === "cloze" && !existing) {
				form.createDiv({
					cls: "hl-quiz-help",
					text: "在事件总结中选中答案，再生成填空。",
				});
				form.createDiv({ cls: "hl-quiz-field-label", text: "事件总结" });
				const source = form.createEl("textarea", {
					cls: "hl-quiz-textarea",
					placeholder: "请先填写事件总结",
				});
				source.value = summary;
				source.readOnly = true;
				const make = form.createEl("button", { text: "生成挖空" });
				make.addEventListener("click", () => {
					const from = source.selectionStart;
					const to = source.selectionEnd;
					if (!source.value.slice(from, to).trim()) {
						new Notice("请先选中要挖空的答案。");
						return;
					}
					({ question, answer } = makeClozeMarked(rawSummary, from, to));
					paintForm();
				});
			}

			if (kind === "year")
				form.createDiv({
					cls: "hl-quiz-help",
					text: "答案始终跟随事件的年份标签。",
				});
			textArea(
				form,
				"问题",
				question,
				kind === "year"
					? "题目正面显示的事件内容"
					: "问题（支持 Markdown）",
				(value) => (question = value)
			);
			if (kind !== "year")
				textArea(
					form,
					"答案",
					answer,
					"答案（支持 Markdown）",
					(value) => (answer = value)
				);
			else
				form.createDiv({
					cls: "hl-quiz-year-answer",
					text: quizAnswer(
						{
							...(existing ?? emptyQuiz(this.opts.event.id)),
							kind: "year",
						},
						this.opts.event
					),
				});
			textArea(form, "提示（可选）", hint, "提示", (value) => (hint = value));
		};
		paintForm();

		const foot = host.createDiv({ cls: "hl-modal-foot" });
		const cancel = foot.createEl("button", { text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const spacer = foot.createSpan({ cls: "hl-modal-foot-spacer" });
		void spacer;
		const save = foot.createEl("button", { text: "保存" });
		save.addEventListener("click", () =>
			void this.save(existing, kind, question, answer, hint, false)
		);
		const practice = foot.createEl("button", {
			cls: "mod-cta",
			text: "保存并练习",
		});
		practice.addEventListener("click", () =>
			void this.save(existing, kind, question, answer, hint, true)
		);
	}

	private async save(
		existing: QuizEntry | undefined,
		kind: QuizKind,
		question: string,
		answer: string,
		hint: string,
		practice: boolean
	): Promise<void> {
		if (!question.trim()) {
			new Notice("请先填写问题。");
			return;
		}
		if (kind !== "year" && !answer.trim()) {
			new Notice("请先填写答案。");
			return;
		}
		if (!(await this.opts.ensure())) return;
		const evId = this.opts.event.id;
		const source = await this.plugin.store.getEvent(evId);
		if (!source || source.tag !== this.opts.tag)
			await this.plugin.store.upsertEvent({
				id: evId,
				tag: this.opts.tag,
				summary: source?.summary ?? "",
			});
		const now = new Date().toISOString();
		const quiz: QuizEntry = existing
			? { ...existing, kind, question, answer, hint, updated: now }
			: {
					...emptyQuiz(evId),
					id: generateId((id) => this.opts.quizIds.has(id)),
					kind,
					question,
					answer,
					hint,
					created: now,
					updated: now,
					cycles: [{ startedAt: now }],
			  };
		await this.plugin.store.upsertQuiz(quiz);
		await this.plugin.refreshTimelines();
		this.close();
		if (practice)
			new QuizPracticeModal(this.app, this.plugin, quiz.id, () =>
				this.opts.onSaved()
			).open();
		else this.opts.onSaved();
	}

	onClose(): void {
		this.plugin.modalStash.untrack(this);
		this.contentEl.empty();
		this.opts.onClosed();
	}
}

function renderQuizModalHead(
	host: HTMLElement,
	tag: string,
	title: string
): void {
	const head = host.createDiv({ cls: "hl-modal-head hl-quiz-modal-head" });
	const decoded = parseYearTag(tag);
	head.createSpan({
		cls: "hl-modal-year",
		text: decoded ? describeYear(decoded) : tag,
	});
	head.createSpan({ cls: "hl-modal-tag", text: title });
}

export class QuizPracticeModal extends Modal {
	protected quiz?: QuizEntry;
	private event?: EventEntry;
	private dbColors: DbColors = new Map();
	protected revealed = false;
	protected hintShown = false;

	constructor(
		app: App,
		protected plugin: HistoryLoggingPlugin,
		protected quizId: string,
		protected onClosed?: () => void
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.plugin.modalStash.track(this);
		await this.loadQuiz();
		this.render();
	}

	protected async loadQuiz(): Promise<void> {
		this.quiz = (await this.plugin.store.readQuizzes()).get(this.quizId);
		this.event = this.quiz
			? await this.plugin.store.getEvent(this.quiz.sourceEvId)
			: undefined;
		this.dbColors = await loadDbColors(this.plugin);
	}

	// Reload quiz/event/colors but keep the reveal and hint state.
	async onStashRestore(): Promise<void> {
		this.quiz = (await this.plugin.store.readQuizzes()).get(this.quizId);
		this.event = this.quiz
			? await this.plugin.store.getEvent(this.quiz.sourceEvId)
			: undefined;
		this.dbColors = await loadDbColors(this.plugin);
		this.render();
	}

	protected render(): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-quiz-practice");
		const quiz = this.quiz;
		// Map quizzes get the immersive exam layout: the zoomable map fills
		// the whole window, the question floats on top and the answer slides
		// in as a bottom drawer.
		const isMap = quiz?.kind === "map";
		this.modalEl.toggleClass("hl-map-exam-window", isMap);
		host.toggleClass("hl-map-exam", isMap);
		this.renderBanner(host);
		if (!quiz) {
			host.createDiv({ cls: "hl-empty", text: "找不到这个 Quiz。" });
			return;
		}
		const schedule = quizSchedule(this.plugin.settings);
		const ready = isQuizReady(quiz, new Date(), schedule);
		if (isMap) {
			this.renderMapExam(host, quiz, ready, schedule);
			return;
		}

		const head = host.createDiv({ cls: "hl-quiz-practice-head" });
		head.createSpan({ cls: "hl-quiz-practice-title", text: "Quiz" });
		const state = head.createDiv({ cls: "hl-quiz-practice-state" });
		state.createSpan({
			text: quiz.status === "mastered" ? "学过" : "在学",
		});
		state.createSpan({
			text: `掌握 ${quiz.progress}/${this.plugin.settings.quizMasterySteps}`,
		});
		if (!ready)
			state.createSpan({
				cls: "hl-quiz-cooling",
				text: nextReviewLabel(quiz, new Date(), schedule),
			});

		const surface = host.createDiv({ cls: "hl-quiz-practice-surface" });
		{
			const context = surface.createDiv({
				cls: "hl-quiz-practice-context",
			});
			const decoded = this.event?.tag
				? parseYearTag(this.event.tag)
				: null;
			context.createSpan({
				text: decoded
					? describeYear(decoded)
					: this.event?.tag ?? "来源事件已不存在",
			});
		}

		const questionPanel = surface.createDiv({
			cls: `hl-quiz-practice-panel hl-quiz-practice-question-panel${
				clozeRevealsInline(quiz) ? " is-cloze" : ""
			}`,
		});
		questionPanel.createDiv({
			cls: "hl-quiz-practice-label",
			text: clozeRevealsInline(quiz) ? "填空" : "问题",
		});
		const question = questionPanel.createDiv({
			cls: "hl-quiz-practice-question",
		});
		renderQuizText(
			this.plugin,
			quizQuestion(quiz, this.event, this.revealed),
			question,
			this.dbColors
		);

		if (this.hintShown && quiz.hint) {
			const hint = questionPanel.createDiv({ cls: "hl-quiz-practice-hint" });
			hint.createSpan({ text: "提示" });
			const hintBody = hint.createDiv();
			renderQuizText(this.plugin, quiz.hint, hintBody, this.dbColors);
		}

		const answerPanel = surface.createDiv({
			cls: `hl-quiz-practice-panel hl-quiz-practice-answer-panel${
				this.revealed ? " is-revealed" : ""
			}`,
		});
		answerPanel.createDiv({
			cls: "hl-quiz-practice-label",
			text: "答案",
		});
		if (!this.revealed) {
			answerPanel.createDiv({
				cls: "hl-quiz-practice-placeholder",
				text: clozeRevealsInline(quiz)
					? "先在心里补全空缺，再显示答案"
					: "先在心里回答，再显示答案",
			});
		} else if (clozeRevealsInline(quiz)) {
			answerPanel.createDiv({
				cls: "hl-quiz-practice-inline-note",
				text: "答案已在上方空缺处原位显示",
			});
		} else {
			const answer = answerPanel.createDiv({
				cls: "hl-quiz-practice-answer",
			});
			renderQuizText(
				this.plugin,
				quizAnswer(quiz, this.event),
				answer,
				this.dbColors
			);
		}

		this.renderPracticeFooter(host, quiz, ready, schedule, false);
	}

	// Immersive map exam: a solid header bar (the "lintel") holds the
	// question, the map fills the rest of the window, and the answer rises
	// as a matching solid drawer above the action bar. The view opens
	// gently focused on the asked frame.
	private renderMapExam(
		host: HTMLElement,
		quiz: QuizEntry,
		ready: boolean,
		schedule: QuizSchedule
	): void {
		renderMapExamHeader(this.plugin, host, quiz, {
			showSource: true,
			coolingLabel: ready
				? ""
				: nextReviewLabel(quiz, new Date(), schedule),
			colors: this.dbColors,
		});
		const stageHost = host.createDiv({
			cls: "hl-occ-stage-host hl-map-exam-stage",
		});
		void renderMapExamStage(
			this.plugin,
			quiz,
			stageHost,
			this.revealed,
			!this.revealed
		);

		const bottom = stageHost.createDiv({ cls: "hl-map-exam-bottombar" });
		if (this.hintShown && quiz.hint) {
			const hint = bottom.createDiv({ cls: "hl-map-exam-hint" });
			hint.createSpan({ text: "提示" });
			const hintBody = hint.createDiv();
			renderQuizText(this.plugin, quiz.hint, hintBody, this.dbColors);
		}
		const answerText = this.revealed ? quizAnswer(quiz, this.event) : "";
		if (answerText.trim()) {
			const drawer = bottom.createDiv({ cls: "hl-map-exam-drawer" });
			const answer = drawer.createDiv({ cls: "hl-map-exam-answer" });
			renderQuizText(this.plugin, answerText, answer, this.dbColors);
		}
		this.renderPracticeFooter(bottom, quiz, ready, schedule, true);
	}

	private renderPracticeFooter(
		host: HTMLElement,
		quiz: QuizEntry,
		ready: boolean,
		schedule: QuizSchedule,
		isMap: boolean
	): void {
		const footer = host.createDiv({ cls: "hl-quiz-practice-footer" });
		const auxiliary = footer.createDiv({
			cls: "hl-quiz-practice-auxiliary",
		});
		const sourceMapId = quiz.sourceMapId;
		if (isMap && sourceMapId) {
			const edit = auxiliary.createEl("button", {
				cls: "hl-map-exam-editbtn",
			});
			setIcon(edit, "pencil");
			edit.createSpan({ text: "编辑地图" });
			edit.addEventListener("click", () =>
				void this.plugin.openMapViewer(sourceMapId, () =>
					void this.onStashRestore()
				)
			);
		}
		if (quiz.hint && !this.hintShown) {
			const hint = auxiliary.createEl("button", { text: "提示" });
			hint.addEventListener("click", () => {
				this.hintShown = true;
				this.render();
			});
		}
		const actions = footer.createDiv({ cls: "hl-quiz-review-actions" });
		if (!this.revealed) {
			const show = actions.createEl("button", {
				cls: "mod-cta hl-quiz-show-answer",
				text: "显示答案",
			});
			show.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
			return;
		}
		if (!ready || quiz.status !== "active") {
			if (quiz.status === "active")
				actions.createSpan({
					cls: "hl-quiz-wait-note",
					text: nextReviewLabel(quiz, new Date(), schedule),
				});
			const done = actions.createEl("button", {
				cls: "mod-cta",
				text: "关闭",
			});
			done.addEventListener("click", () => this.close());
			return;
		}
		for (const [result, label] of [
			["forgot", "不记得"],
			["remembered", "记得"],
		] as [QuizResult, string][]) {
			const button = actions.createEl("button", { text: label });
			if (result === "remembered") button.addClass("mod-cta");
			button.setAttr(
				"aria-label",
				result === "forgot"
					? "不记得：掌握退一级并进入等待"
					: "记得：掌握进一级"
			);
			button.addEventListener("click", () => void this.rate(result));
		}
	}

	private async rate(result: QuizResult): Promise<void> {
		if (!this.quiz) return;
		const schedule = quizSchedule(this.plugin.settings);
		const updated = reviewQuiz(this.quiz, result, new Date(), schedule);
		await this.plugin.store.upsertQuiz(updated);
		this.plugin.remindQuizWhenReady(updated);
		await this.plugin.refreshTimelines();
		new Notice(
			rateNotice(updated, this.plugin.settings.quizMasterySteps, schedule)
		);
		this.afterRate(updated);
	}

	// Hooks for the reminder subclass: an extra banner above the head, and
	// what happens after rating (default: close).
	protected renderBanner(_host: HTMLElement): void {}

	protected afterRate(_updated: QuizEntry): void {
		this.close();
	}

	onClose(): void {
		this.plugin.modalStash.untrack(this);
		this.contentEl.empty();
		this.onClosed?.();
	}
}

function emptyQuiz(sourceEvId: string): QuizEntry {
	const now = new Date().toISOString();
	return {
		id: "",
		sourceEvId,
		kind: "qa",
		status: "active",
		progress: 0,
		created: now,
		updated: now,
		question: "",
		answer: "",
		hint: "",
		attempts: [],
		cycles: [],
	};
}

function quizKindLabel(kind: QuizKind): string {
	if (kind === "year") return "Year";
	if (kind === "cloze") return "Cloze";
	if (kind === "map") return "地图";
	return "Q&A";
}


