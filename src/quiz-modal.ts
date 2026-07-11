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
	pauseQuiz,
	resumeQuiz,
	reviewQuiz,
	reviveQuiz,
} from "./quiz";
import {
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
		private ensure?: () => Promise<boolean>
	) {
		super(app);
		this.ensured = !ensure;
	}

	async onOpen(): Promise<void> {
		await this.reload();
		if (!this.eventQuizzes.length || this.clozeAnswer)
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
		this.renderHead(host, `Quizzes (${this.eventQuizzes.length})`);

		const list = host.createDiv({ cls: "hl-quiz-manage-list" });
		for (const quiz of this.eventQuizzes) {
			const row = list.createDiv({ cls: "hl-quiz-manage-row" });
			const main = row.createDiv({ cls: "hl-quiz-manage-main" });
			main.createDiv({
				cls: "hl-quiz-kind",
				text: quiz.kind === "qa" ? "Q&A" : quiz.kind,
			});
			main.createDiv({
				cls: "hl-quiz-manage-question",
				text: quizQuestion(quiz, this.event).replace(/\s+/g, " ").trim(),
			});
			main.createDiv({
				cls: "hl-quiz-manage-meta",
				text: `${quiz.status} · ${quiz.progress}/${
					this.plugin.settings.quizMasterySteps
				} · ${nextReviewLabel(quiz)}`,
			});

			const practice = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(practice, "play");
			practice.setAttr("aria-label", "Practice now");
			practice.disabled = quiz.status !== "active";
			practice.addEventListener("click", () => {
				this.close();
				new QuizPracticeModal(this.app, this.plugin, quiz.id).open();
			});

			const edit = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(edit, "pencil");
			edit.setAttr("aria-label", "Edit quiz");
			edit.addEventListener("click", () => this.renderEditor(quiz));

			const more = row.createEl("button", { cls: "hl-icon-btn" });
			setIcon(more, "more-horizontal");
			more.setAttr("aria-label", "More quiz actions");
			more.addEventListener("click", () => {
				const actions = row.createDiv({ cls: "hl-quiz-inline-actions" });
				more.remove();
				if (quiz.status === "mastered")
					this.actionButton(actions, "Revive", () =>
						this.changeQuiz(reviveQuiz(quiz))
					);
				else if (quiz.status === "paused")
					this.actionButton(actions, "Resume", () =>
						this.changeQuiz(resumeQuiz(quiz))
					);
				else if (quiz.status === "active")
					this.actionButton(actions, "Pause", () =>
						this.changeQuiz(pauseQuiz(quiz))
					);
				this.actionButton(actions, "Delete", () => this.confirmDelete(quiz));
			});
		}

		const foot = host.createDiv({ cls: "hl-modal-foot hl-quiz-manager-foot" });
		const add = foot.createEl("button", {
			cls: "mod-cta",
			text: "New quiz",
		});
		add.addEventListener("click", () => this.renderEditor(undefined, "year"));
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
			"Delete quiz",
			"Delete this quiz and all of its attempt history?",
			"Delete",
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
		this.renderHead(host, existing ? "Edit quiz" : "New quiz");

		let kind = existing?.kind ?? initialKind;
		const tabs = host.createDiv({ cls: "hl-quiz-kind-tabs" });
		const form = host.createDiv({ cls: "hl-quiz-form" });
		const kinds: [QuizKind, string][] = [
			["year", "Year"],
			["cloze", "Cloze"],
			["qa", "Q&A"],
		];
		const tabEls = new Map<QuizKind, HTMLElement>();
		for (const [value, label] of kinds) {
			const tab = tabs.createSpan({ cls: "hl-quiz-kind-tab", text: label });
			tabEls.set(value, tab);
			tab.addEventListener("click", () => {
				kind = value;
				paintForm();
			});
		}

		let question = existing?.question ?? "";
		let answer = existing?.answer ?? "";
		let hint = existing?.hint ?? "";
		let sourceSelection = this.clozeAnswer;
		const summary = stripDbMarkers(this.event?.summary ?? "");
		if (!existing && kind === "year")
			question = summary || "When did this event happen?";
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
					text: "Select the answer in the event summary, then make the cloze.",
				});
				const source = textArea(
					form,
					"Event summary",
					summary,
					"Write an event summary first",
					() => undefined
				);
				source.readOnly = true;
				const make = form.createEl("button", { text: "Make cloze" });
				make.addEventListener("click", () => {
					sourceSelection = source.value.slice(
						source.selectionStart,
						source.selectionEnd
					);
					if (!sourceSelection.trim()) {
						new Notice("Select the answer text first.");
						return;
					}
					({ question, answer } = makeCloze(source.value, sourceSelection));
					paintForm();
				});
			}

			if (kind === "year")
				form.createDiv({
					cls: "hl-quiz-help",
					text: "The answer always follows the event's year tag.",
				});
			textArea(
				form,
				"Question",
				question,
				kind === "year"
					? "Event summary shown on the front"
					: "Question (Markdown supported)",
				(value) => (question = value)
			);
			if (kind !== "year")
				textArea(
					form,
					"Answer",
					answer,
					"Answer (Markdown supported)",
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
			textArea(form, "Hint (optional)", hint, "Hint", (value) => (hint = value));
		};
		paintForm();

		const foot = host.createDiv({ cls: "hl-modal-foot" });
		if (existing || this.eventQuizzes.length) {
			const back = foot.createEl("button", { text: "Back" });
			back.addEventListener("click", () => this.renderManager());
		}
		const spacer = foot.createSpan({ cls: "hl-modal-foot-spacer" });
		void spacer;
		const save = foot.createEl("button", { text: "Save" });
		save.addEventListener("click", () =>
			void this.saveEditor(existing, kind, question, answer, hint, false)
		);
		const practice = foot.createEl("button", {
			cls: "mod-cta",
			text: "Save & practice now",
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
			new Notice("Write a question first.");
			return;
		}
		if (kind !== "year" && !answer.trim()) {
			new Notice("Write an answer first.");
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

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private quizId: string
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
			host.createDiv({ cls: "hl-empty", text: "Quiz not found." });
			return;
		}

		const head = host.createDiv({ cls: "hl-quiz-practice-head" });
		head.createSpan({
			text: `Progress ${quiz.progress}/${this.plugin.settings.quizMasterySteps}`,
		});
		const ready = isQuizReady(quiz);
		head.createSpan({
			cls: ready ? "hl-quiz-ready" : "hl-quiz-cooling",
			text: ready ? "Ready" : nextReviewLabel(quiz),
		});

		const question = host.createDiv({ cls: "hl-quiz-practice-question" });
		void MarkdownRenderer.render(
			this.app,
			quizQuestion(quiz, this.event),
			question,
			"",
			this.plugin
		);

		if (!this.revealed) {
			if (!ready)
				host.createDiv({
					cls: "hl-quiz-early-note",
					text: "Early success is recorded but does not advance mastery.",
				});
			const show = host.createEl("button", {
				cls: "mod-cta hl-quiz-show-answer",
				text: ready ? "Show answer" : "Practice now",
			});
			show.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
			return;
		}

		if (quiz.hint) {
			const hint = host.createDiv({ cls: "hl-quiz-hint" });
			void MarkdownRenderer.render(
				this.app,
				quiz.hint,
				hint,
				"",
				this.plugin
			);
		}
		const answer = host.createDiv({ cls: "hl-quiz-practice-answer" });
		void MarkdownRenderer.render(
			this.app,
			quizAnswer(quiz, this.event),
			answer,
			"",
			this.plugin
		);
		const actions = host.createDiv({ cls: "hl-quiz-review-actions" });
		for (const [result, label] of [
			["forgot", "Forgot"],
			["fuzzy", "Fuzzy"],
			["remembered", "Remembered"],
		] as [QuizResult, string][]) {
			const button = actions.createEl("button", { text: label });
			if (result === "remembered") button.addClass("mod-cta");
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
		await this.plugin.refreshTimelines();
		new Notice(
			updated.status === "mastered"
				? "Quiz mastered and archived."
				: `Quiz progress: ${updated.progress}/${this.plugin.settings.quizMasterySteps}`
		);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
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
