// In-view event-quiz session: same data flow as QuizSessionModal (reviewQuiz
// → store → reminder scheduling), presented as a flip-card player page.
// Cards of this deck coming off a short wait while the session runs are
// interjected right after the current card instead of raising an alarm.

import { setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EventEntry } from "./types";
import {
	QuizEntry,
	QuizResult,
	isQuizReady,
	isQuizWaiting,
	reviewQuiz,
} from "./quiz";
import {
	clozeRevealsInline,
	nextReviewLabel,
	quizAnswer,
	quizQuestion,
	quizSchedule,
} from "./quiz-display";
import { DbColors, loadDbColors, renderQuizText } from "./quiz-render";
import {
	SessionQueueState,
	interject,
	pruneUpcoming,
	shuffle,
} from "./session-queue";
import { PlayerPage } from "./player-shell";
import { QuizEditorModal } from "./quiz-modal";

export class QuizPlayerPage extends PlayerPage {
	private queue: SessionQueueState = { ids: [], index: 0 };
	private quizzes = new Map<string, QuizEntry>();
	private events = new Map<string, EventEntry>();
	private dbColors: DbColors = new Map();
	private results: Record<QuizResult, number> = {
		remembered: 0,
		fuzzy: 0,
		forgot: 0,
	};
	private masteredNow = 0;
	private weakIds = new Set<string>();
	private answered = new Set<string>();
	private hintShown = false;
	private waitMode = false;
	private editing = false;
	private waitTimer = 0;
	private loaded = false;
	// `updated` stamps at snapshot time, to tell "answered elsewhere" apart
	// from "was queued while not yet due" during revalidation.
	private stamps = new Map<string, string>();
	// Deck cards already sitting out a short wait when the session started:
	// part of the session's waiting bucket, interjected once due.
	private waitingPool = new Set<string>();

	constructor(
		plugin: HistoryLoggingPlugin,
		deckLabel: string,
		private sessionIds: string[],
		// Every quiz id belonging to the deck — the interjection scope.
		private scopeIds: Set<string>,
		// Profile behind this deck ("" for cross-deck sessions) — timeline
		// jumps land on this profile's layout.
		private profileName: string,
		onExit: () => void
	) {
		super(plugin, deckLabel, onExit);
	}

	async load(): Promise<void> {
		const [allQuizzes, events, colors] = await Promise.all([
			this.plugin.store.readQuizzes(),
			this.plugin.store.readEvents(),
			loadDbColors(this.plugin),
		]);
		this.quizzes = allQuizzes;
		this.events = events;
		this.dbColors = colors;
		this.queue = {
			ids: shuffle(
				this.sessionIds.filter((id) => allQuizzes.has(id))
			),
			index: 0,
		};
		for (const id of this.queue.ids) {
			const quiz = allQuizzes.get(id);
			if (quiz) this.stamps.set(id, quiz.updated);
		}
		const schedule = quizSchedule(this.plugin.settings);
		const now = new Date();
		const queued = new Set(this.queue.ids);
		for (const [id, quiz] of allQuizzes) {
			if (!this.scopeIds.has(id) || queued.has(id)) continue;
			if (quiz.status !== "active") continue;
			if (isQuizWaiting(quiz, now, schedule)) {
				this.waitingPool.add(id);
				this.stamps.set(id, quiz.updated);
			}
		}
		this.loaded = true;
		if (this.finished() && this.waitingIds().length) this.waitMode = true;
		this.render();
	}

	// A deck quiz came off its short wait while this page is on screen.
	// Returns true when consumed (the alarm stays silent).
	handleDueQuiz(quiz: QuizEntry): boolean {
		if (!this.loaded || !this.scopeIds.has(quiz.id)) return false;
		this.waitingPool.delete(quiz.id);
		this.quizzes.set(quiz.id, quiz);
		this.stamps.set(quiz.id, quiz.updated);
		if (this.queue.ids[this.queue.index] === quiz.id) return true;
		if (this.waitMode || this.finished()) {
			this.queue = {
				ids: [...this.queue.ids, quiz.id],
				index: this.queue.ids.length,
			};
			this.waitMode = false;
			this.revealed = false;
			this.hintShown = false;
			this.render();
			this.toast("⏰ 重试到点，继续背诵");
			return true;
		}
		this.queue = interject(this.queue, [
			{ id: quiz.id, due: quiz.nextReview ?? "" },
		]);
		this.render();
		this.toast("⏰ 1 道重试到点 · 已排到下一张");
		return true;
	}

	// After the view regains focus: drop upcoming cards answered elsewhere.
	async revalidate(): Promise<void> {
		if (!this.loaded || this.finished()) return;
		const fresh = await this.plugin.store.readQuizzes();
		this.quizzes = fresh;
		const schedule = quizSchedule(this.plugin.settings);
		const before = this.queue.ids.length;
		this.queue = pruneUpcoming(this.queue, (id) => {
			const quiz = fresh.get(id);
			if (!quiz || quiz.status !== "active") return false;
			// Untouched since the snapshot → keep (even a not-yet-due card
			// deliberately included by an "all active" session).
			if (this.stamps.get(id) === quiz.updated) return true;
			this.stamps.set(id, quiz.updated);
			return isQuizReady(quiz, new Date(), schedule);
		});
		const now = new Date();
		const due: { id: string; due: string }[] = [];
		for (const id of [...this.waitingPool]) {
			const quiz = fresh.get(id);
			if (!quiz || quiz.status !== "active") {
				this.waitingPool.delete(id);
				continue;
			}
			this.stamps.set(id, quiz.updated);
			if (isQuizReady(quiz, now, schedule)) {
				this.waitingPool.delete(id);
				due.push({ id, due: quiz.nextReview ?? "" });
			} else if (!isQuizWaiting(quiz, now, schedule))
				this.waitingPool.delete(id);
		}
		if (due.length) {
			this.queue = interject(this.queue, due);
			if (this.waitMode && this.queue.index < this.queue.ids.length) {
				this.waitMode = false;
				this.revealed = false;
				this.hintShown = false;
			}
		}
		if (this.queue.ids.length !== before) {
			this.render();
			this.toast("部分题目已在别处作答，已从队列移除");
		} else this.render();
	}

	protected done(): number {
		return this.queue.index;
	}

	protected total(): number {
		return this.queue.ids.length;
	}

	protected finished(): boolean {
		return this.loaded && this.queue.index >= this.queue.ids.length;
	}

	// Session-clearing semantics: a card only counts as cleared once it is
	// answered and NOT sitting out a short retry/recheck wait — "forgot" and
	// a first "remembered" move it to the waiting bucket instead.
	private sessionState(): {
		total: number;
		cleared: number;
		waiting: number;
		remaining: number;
	} {
		const schedule = quizSchedule(this.plugin.settings);
		const now = new Date();
		const queued = new Set(this.queue.ids);
		const ids = new Set([...this.queue.ids, ...this.waitingPool]);
		let cleared = 0;
		let waiting = 0;
		for (const id of ids) {
			const quiz = this.quizzes.get(id);
			if (!quiz || quiz.status === "mastered") {
				cleared++;
				continue;
			}
			if (isQuizWaiting(quiz, now, schedule)) {
				waiting++;
				continue;
			}
			if (
				!isQuizReady(quiz, now, schedule) &&
				(this.answered.has(id) || !queued.has(id))
			)
				cleared++;
		}
		return {
			total: ids.size,
			cleared,
			waiting,
			remaining: ids.size - cleared - waiting,
		};
	}

	protected counterText(): string {
		const s = this.sessionState();
		return s.waiting
			? `剩余 ${s.remaining} · 等待重试 ${s.waiting}`
			: `剩余 ${s.remaining} · 共 ${s.total} 题`;
	}

	protected progressSegments(): { cls: string; frac: number }[] {
		const s = this.sessionState();
		if (!s.total) return [];
		return [
			{ cls: "", frac: s.cleared / s.total },
			{ cls: "is-wait", frac: s.waiting / s.total },
		];
	}

	private current(): QuizEntry | null {
		const id = this.queue.ids[this.queue.index];
		return (id && this.quizzes.get(id)) || null;
	}

	private eventOf(quiz: QuizEntry): EventEntry | undefined {
		return this.events.get(quiz.sourceEvId);
	}

	protected renderFront(card: HTMLElement): void {
		const quiz = this.current();
		if (!quiz) return;
		const question = card.createDiv({ cls: "hl-player-question" });
		renderQuizText(
			this.plugin,
			quizQuestion(quiz, this.eventOf(quiz), false),
			question,
			this.dbColors
		);
		if (this.hintShown && quiz.hint) {
			const hint = card.createDiv({ cls: "hl-player-hint" });
			renderQuizText(this.plugin, quiz.hint, hint, this.dbColors);
		}
	}

	protected renderBack(card: HTMLElement): void {
		const quiz = this.current();
		if (!quiz) return;
		const question = card.createDiv({
			cls: "hl-player-question hl-player-question-dim",
		});
		renderQuizText(
			this.plugin,
			quizQuestion(quiz, this.eventOf(quiz), true),
			question,
			this.dbColors
		);
		if (!clozeRevealsInline(quiz)) {
			const answer = card.createDiv({ cls: "hl-player-answer" });
			renderQuizText(
				this.plugin,
				quizAnswer(quiz, this.eventOf(quiz)),
				answer,
				this.dbColors
			);
		}
		if (this.hintShown && quiz.hint) {
			const hint = card.createDiv({ cls: "hl-player-hint" });
			renderQuizText(this.plugin, quiz.hint, hint, this.dbColors);
		}
	}

	protected headExtra(head: HTMLElement): void {
		const quiz = this.current();
		if (!quiz) return;
		const steps = this.plugin.settings.quizMasterySteps;
		const dots = head.createSpan({ cls: "hl-player-dots" });
		dots.setAttr("aria-label", `掌握 ${quiz.progress}/${steps}`);
		for (let i = 0; i < steps; i++)
			dots.createSpan({
				cls:
					i < quiz.progress
						? "hl-player-dot is-on"
						: "hl-player-dot",
			});
	}

	protected footerExtras(left: HTMLElement, right: HTMLElement): void {
		const quiz = this.current();
		if (!quiz) return;
		if (quiz.hint && !this.hintShown) {
			const hintBtn = left.createEl("button", {
				cls: "hl-player-hint-btn",
				text: "💡 提示",
			});
			hintBtn.addEventListener("click", () => {
				this.hintShown = true;
				this.render();
			});
		}
		const edit = right.createEl("button", {
			cls: "hl-icon-btn hl-player-reveal",
		});
		setIcon(edit, "pencil");
		edit.setAttr("aria-label", "编辑这道 Quiz (E)");
		edit.addEventListener("click", () => this.openEditor());
		const tag = this.eventOf(quiz)?.tag;
		if (tag) {
			const reveal = right.createEl("button", {
				cls: "hl-icon-btn hl-player-reveal",
			});
			setIcon(reveal, "gantt-chart");
			reveal.setAttr("aria-label", "在时间线上显示");
			reveal.addEventListener("click", () =>
				void (this.profileName
					? this.plugin.revealOnTimelineForProfile(
							this.profileName,
							quiz.sourceEvId,
							tag
						)
					: this.plugin.revealOnTimeline(quiz.sourceEvId, tag))
			);
		}
	}

	protected renderActions(bar: HTMLElement): void {
		const quiz = this.current();
		if (!quiz) return;
		const schedule = quizSchedule(this.plugin.settings);
		if (!isQuizReady(quiz, new Date(), schedule)) {
			bar.createSpan({
				cls: "hl-quiz-wait-note",
				text: nextReviewLabel(quiz, new Date(), schedule),
			});
			const next = bar.createEl("button", {
				cls: "mod-cta",
				text: "下一题",
			});
			next.addEventListener("click", () => this.advance());
			return;
		}
		for (const [result, label, key, note] of [
			["forgot", "不记得", "1", "退一级 · 10 分钟后重试"],
			["remembered", "记得", "2", "进一级"],
		] as [QuizResult, string, string, string][]) {
			const button = bar.createEl("button", {
				cls: "hl-player-rate",
			});
			if (result === "remembered") button.addClass("mod-cta");
			button.createDiv({ text: label });
			button.createDiv({
				cls: "hl-player-rate-note",
				text: `${key} · ${note}`,
			});
			button.addEventListener("click", () =>
				void this.rate(quiz, result)
			);
		}
	}

	handleKey(ev: KeyboardEvent): boolean {
		if (this.editing) return false;
		if ((ev.key === "e" || ev.key === "E") && !this.finished()) {
			this.openEditor();
			return true;
		}
		return super.handleKey(ev);
	}

	// E / footer pencil: edit the current quiz's text fields in place.
	// Scheduling state is untouched; the card re-renders on save.
	private openEditor(): void {
		const quiz = this.current();
		const event = quiz && this.eventOf(quiz);
		if (!quiz || !event) return;
		this.editing = true;
		new QuizEditorModal(this.plugin.app, this.plugin, {
			event,
			tag: event.tag ?? "",
			quizIds: new Set(this.quizzes.keys()),
			existing: quiz,
			initialKind: quiz.kind,
			clozeAnswer: "",
			ensure: async () => true,
			onSaved: () => void this.reloadCurrent(quiz.id),
			onClosed: () => {
				this.editing = false;
			},
		}).open();
	}

	private async reloadCurrent(id: string): Promise<void> {
		const fresh = await this.plugin.store.readQuizzes();
		const updated = fresh.get(id);
		if (updated) {
			this.quizzes.set(id, updated);
			this.stamps.set(id, updated.updated);
		}
		void this.plugin.refreshTimelines();
		this.render();
	}

	protected rateFromKey(n: number): boolean {
		const quiz = this.current();
		if (!quiz) return false;
		const schedule = quizSchedule(this.plugin.settings);
		if (!isQuizReady(quiz, new Date(), schedule)) {
			if (n === 1 || n === 2) this.advance();
			return true;
		}
		if (n === 1) void this.rate(quiz, "forgot");
		else if (n === 2) void this.rate(quiz, "remembered");
		else return false;
		return true;
	}

	private async rate(quiz: QuizEntry, result: QuizResult): Promise<void> {
		const updated = reviewQuiz(
			quiz,
			result,
			new Date(),
			quizSchedule(this.plugin.settings)
		);
		await this.plugin.store.upsertQuiz(updated);
		this.plugin.remindQuizWhenReady(updated);
		void this.plugin.refreshTimelines();
		this.quizzes.set(quiz.id, updated);
		this.results[result]++;
		this.answered.add(quiz.id);
		if (result === "remembered") {
			this.weakIds.delete(quiz.id);
			if (updated.status === "mastered") this.masteredNow++;
		} else this.weakIds.add(quiz.id);
		this.advance();
	}

	private advance(): void {
		this.queue = { ...this.queue, index: this.queue.index + 1 };
		this.revealed = false;
		this.hintShown = false;
		// Clearing is the session's promise: reaching the end of the queue
		// with cards still in retry wait keeps the session open by default.
		if (this.finished() && this.waitingIds().length) this.waitMode = true;
		this.render();
	}

	// Session quizzes now sitting out a short retry/recheck wait.
	private waitingIds(): string[] {
		const schedule = quizSchedule(this.plugin.settings);
		const now = new Date();
		return [
			...new Set([...this.queue.ids, ...this.waitingPool]),
		].filter((id) => {
			const quiz = this.quizzes.get(id);
			return !!quiz && isQuizWaiting(quiz, now, schedule);
		});
	}

	protected renderSummary(host: HTMLElement): void {
		window.clearInterval(this.waitTimer);
		const waiting = this.waitingIds();
		const card = host.createDiv({
			cls: "hl-player-card hl-player-summary",
		});
		card.createEl("h2", {
			text: this.waitMode ? "等待重试" : "练习完成",
		});
		card.createDiv({
			cls: "hl-player-summary-time",
			text: `${this.answered.size} 道 · 用时 ${this.durationLabel()}`,
		});
		const tallies = card.createDiv({ cls: "hl-player-tallies" });
		const tally = (
			cls: string,
			value: number,
			label: string
		): void => {
			const box = tallies.createDiv({ cls: `hl-player-tally ${cls}` });
			box.createDiv({ cls: "hl-player-tally-num", text: String(value) });
			box.createDiv({ cls: "hl-player-tally-label", text: label });
		};
		tally("is-ok", this.results.remembered, "记得");
		tally("is-bad", this.results.forgot, "不记得");
		if (this.masteredNow) tally("", this.masteredNow, "升到掌握");

		if (waiting.length) {
			const note = card.createDiv({ cls: "hl-player-wait-note" });
			const label = (): string => {
				const schedule = quizSchedule(this.plugin.settings);
				const soonest = waiting
					.map((id) => this.quizzes.get(id))
					.filter((q): q is QuizEntry => !!q)
					.sort((a, b) =>
						(a.nextReview ?? "").localeCompare(b.nextReview ?? "")
					)[0];
				const when = soonest
					? nextReviewLabel(soonest, new Date(), schedule)
					: "";
				return `⏰ ${waiting.length} 道在重试等待中${
					when ? ` · 最近 ${when}` : ""
				}${this.waitMode ? "，到点自动续上" : ""}`;
			};
			note.setText(label());
			if (this.waitMode) {
				this.waitTimer = window.setInterval(() => {
					if (!note.isConnected) {
						window.clearInterval(this.waitTimer);
						return;
					}
					note.setText(label());
				}, 15_000);
			}
		}

		const actions = card.createDiv({ cls: "hl-player-summary-actions" });
		if (this.weakIds.size) {
			const retry = actions.createEl("button", {
				text: `重练弱项 ${this.weakIds.size}`,
			});
			retry.addEventListener("click", () => this.retestWeak());
		}
		const done = actions.createEl("button", {
			cls: this.weakIds.size || waiting.length ? "" : "mod-cta",
			text: "返回 deck 列表",
		});
		done.addEventListener("click", () => this.onExit());
	}

	private retestWeak(): void {
		this.queue = {
			ids: shuffle([...this.weakIds]),
			index: 0,
		};
		this.weakIds.clear();
		this.answered.clear();
		this.results = { remembered: 0, fuzzy: 0, forgot: 0 };
		this.masteredNow = 0;
		this.waitMode = false;
		this.revealed = false;
		this.hintShown = false;
		this.startedAt = Date.now();
		this.render();
	}

	unmount(): void {
		window.clearInterval(this.waitTimer);
		super.unmount();
	}
}
