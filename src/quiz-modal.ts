import {
	App,
	MarkdownRenderer,
	Modal,
	Notice,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import {
	QuizEntry,
	QuizKind,
	QuizResult,
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
} from "./quiz-display";
import { generateId } from "./id";
import { ConfirmModal } from "./name-modal";
import { describeYear, parseYearTag } from "./year-tag";
import { stripDbMarkers } from "./db-marker";

export class QuizManagerModal extends Modal {
	private event?: EventEntry;
	private quizzes = new Map<string, QuizEntry>();
	private eventQuizzes: QuizEntry[] = [];
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
		await this.reload();
		const editQuiz = this.editQuizId
			? this.eventQuizzes.find((quiz) => quiz.id === this.editQuizId)
			: undefined;
		if (editQuiz) this.renderEditor(editQuiz);
		else if (!this.eventQuizzes.length || this.clozeAnswer)
			this.renderEditor(undefined, this.clozeAnswer ? "cloze" : "year");
		else this.renderManager();
	}

	private async reload(): Promise<void> {
		const [event, quizzes] = await Promise.all([
			this.plugin.store.getEvent(this.evId),
			this.plugin.store.readQuizzes(),
		]);
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

	private renderHead(host: HTMLElement, title: string): void {
		const head = host.createDiv({ cls: "hl-modal-head hl-quiz-modal-head" });
		const decoded = parseYearTag(this.tag);
		head.createSpan({
			cls: "hl-modal-year",
			text: decoded ? describeYear(decoded) : this.tag,
		});
		head.createSpan({ cls: "hl-modal-tag", text: title });
	}

	private renderManager(): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-quiz-modal");
		host.removeClass("hl-quiz-editor");
		this.renderHead(host, `Quiz（${this.eventQuizzes.length}）`);

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
			void MarkdownRenderer.render(
				this.app,
				stripDbMarkers(quizQuestion(quiz, this.event)),
				question,
				"",
				this.plugin
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
			setIcon(practice, "play");
			practice.setAttr("aria-label", "练习");
			practice.setAttr("title", "练习");
			practice.disabled = quiz.status !== "active";
			practice.addEventListener("click", () => {
				new QuizPracticeModal(this.app, this.plugin, quiz.id, () =>
					void this.refreshManager()
				).open();
			});

			const edit = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(edit, "pencil");
			edit.setAttr("aria-label", "编辑这个 Quiz");
			edit.addEventListener("click", () => this.renderEditor(quiz));

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
		add.addEventListener("click", () => this.renderEditor(undefined, "year"));
	}

	private async refreshManager(): Promise<void> {
		await this.reload();
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
					await this.reload();
					if (this.eventQuizzes.length) this.renderManager();
					else this.renderEditor(undefined, "year");
				})()
		).open();
	}

	private renderEditor(existing?: QuizEntry, initialKind: QuizKind = "qa"): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-quiz-modal");
		host.addClass("hl-quiz-editor");

		let kind = existing?.kind ?? initialKind;
		this.renderHead(host, existing ? `Edit ${quizKindLabel(kind)}` : "New Quiz");
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
					kind = value;
					paintForm();
				});
			}
		}
		const form = host.createDiv({ cls: "hl-quiz-form" });

		let question = existing?.question ?? "";
		let answer = existing?.answer ?? "";
		let hint = existing?.hint ?? "";
		let sourceSelection = this.clozeAnswer;
		const summary = stripDbMarkers(this.event?.summary ?? "");
		if (!existing && kind === "year")
			question = summary || "这件事发生在哪一年？";
		if (!existing && kind === "cloze" && sourceSelection)
			({ question, answer } = makeCloze(summary, sourceSelection));

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
				const source = textArea(
					form,
					"事件总结",
					summary,
					"请先填写事件总结",
					() => undefined
				);
				source.readOnly = true;
				const make = form.createEl("button", { text: "生成挖空" });
				make.addEventListener("click", () => {
					sourceSelection = source.value.slice(
						source.selectionStart,
						source.selectionEnd
					);
					if (!sourceSelection.trim()) {
						new Notice("请先选中要挖空的答案。");
						return;
					}
					({ question, answer } = makeCloze(source.value, sourceSelection));
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
							...(existing ?? emptyQuiz(this.evId)),
							kind: "year",
						},
						this.event
					),
				});
			textArea(form, "提示（可选）", hint, "提示", (value) => (hint = value));
		};
		paintForm();

		const foot = host.createDiv({ cls: "hl-modal-foot" });
		if (existing || this.eventQuizzes.length) {
			const back = foot.createEl("button", { text: "返回" });
			back.addEventListener("click", () => this.renderManager());
		}
		const spacer = foot.createSpan({ cls: "hl-modal-foot-spacer" });
		void spacer;
		const save = foot.createEl("button", { text: "保存" });
		save.addEventListener("click", () =>
			void this.saveEditor(existing, kind, question, answer, hint, false)
		);
		const practice = foot.createEl("button", {
			cls: "mod-cta",
			text: "保存并练习",
		});
		practice.addEventListener("click", () =>
			void this.saveEditor(existing, kind, question, answer, hint, true)
		);
	}

	private async saveEditor(
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
		if (!this.ensured) {
			if (!(await this.ensure!())) return;
			this.ensured = true;
		}
		const source = await this.plugin.store.getEvent(this.evId);
		if (!source || source.tag !== this.tag)
			await this.plugin.store.upsertEvent({
				id: this.evId,
				tag: this.tag,
				summary: source?.summary ?? "",
			});
		const now = new Date().toISOString();
		const quiz: QuizEntry = existing
			? { ...existing, kind, question, answer, hint, updated: now }
			: {
					...emptyQuiz(this.evId),
					id: generateId((id) => this.quizzes.has(id)),
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
		if (practice) {
			this.close();
			new QuizPracticeModal(this.app, this.plugin, quiz.id).open();
			return;
		}
		await this.reload();
		this.renderManager();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class QuizPracticeModal extends Modal {
	private quiz?: QuizEntry;
	private event?: EventEntry;
	private revealed = false;
	private hintShown = false;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private quizId: string,
		private onClosed?: () => void
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.quiz = (await this.plugin.store.readQuizzes()).get(this.quizId);
		this.event = this.quiz
			? await this.plugin.store.getEvent(this.quiz.sourceEvId)
			: undefined;
		this.render();
	}

	private render(): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-quiz-practice");
		const quiz = this.quiz;
		if (!quiz) {
			host.createDiv({ cls: "hl-empty", text: "找不到这个 Quiz。" });
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
		const schedule = quizSchedule(this.plugin.settings);
		const ready = isQuizReady(quiz, new Date(), schedule);
		if (!ready)
			state.createSpan({
				cls: "hl-quiz-cooling",
				text: nextReviewLabel(quiz, new Date(), schedule),
			});

		const surface = host.createDiv({ cls: "hl-quiz-practice-surface" });
		const context = surface.createDiv({ cls: "hl-quiz-practice-context" });
		const decoded = this.event?.tag ? parseYearTag(this.event.tag) : null;
		context.createSpan({
			text: decoded
				? describeYear(decoded)
				: this.event?.tag ?? "来源事件已不存在",
		});

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
		void MarkdownRenderer.render(
			this.app,
			quizQuestion(quiz, this.event, this.revealed),
			question,
			"",
			this.plugin
		);

		if (this.hintShown && quiz.hint) {
			const hint = questionPanel.createDiv({ cls: "hl-quiz-practice-hint" });
			hint.createSpan({ text: "提示" });
			const hintBody = hint.createDiv();
			void MarkdownRenderer.render(
				this.app,
				quiz.hint,
				hintBody,
				"",
				this.plugin
			);
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
			void MarkdownRenderer.render(
				this.app,
				quizAnswer(quiz, this.event),
				answer,
				"",
				this.plugin
			);
		}

		const footer = host.createDiv({ cls: "hl-quiz-practice-footer" });
		const auxiliary = footer.createDiv({
			cls: "hl-quiz-practice-auxiliary",
		});
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
		const updated = reviewQuiz(
			this.quiz,
			result,
			new Date(),
			quizSchedule(this.plugin.settings)
		);
		await this.plugin.store.upsertQuiz(updated);
		this.plugin.remindQuizWhenReady(updated);
		await this.plugin.refreshTimelines();
		new Notice(
			updated.status === "mastered"
				? "这个 Quiz 已学过。"
				: `掌握进度：${updated.progress}/${this.plugin.settings.quizMasterySteps}`
		);
		this.close();
	}

	onClose(): void {
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
	return "Q&A";
}

function makeCloze(
	summary: string,
	selection: string
): { question: string; answer: string } {
	const answer = selection.trim();
	const index = summary.indexOf(selection);
	if (index < 0) return { question: summary, answer };
	return {
		question: `${summary.slice(0, index)}____${summary.slice(
			index + selection.length
		)}`,
		answer,
	};
}
