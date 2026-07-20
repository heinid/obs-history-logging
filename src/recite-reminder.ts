import { App, Modal, Notice, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EntityEntry } from "./db-format";
import { addMinutes } from "./quiz";
import { quizSchedule, rateNotice } from "./quiz-display";
import { langDisplayName, playEntityAudio } from "./quiz-render";
import {
	ReciteProgress,
	isProgressDue,
	reviewProgress,
	toQuizShape,
} from "./recite-progress";

// Alarm-style reminder for a lexicon direction coming off a short wait
// (forgot retry or first-learn recheck): a light dictionary-style card opens
// on due — masked answer in place, click to reveal, then rate. Directions due
// while it is open join its queue, so at most one window ever exists.
export class ReciteReminderModal extends Modal {
	private queue: string[] = [];
	private rec: ReciteProgress | null = null;
	private entity: EntityEntry | null = null;
	private answerShown = false;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private key: string,
		private onClosed?: () => void
	) {
		super(app);
	}

	enqueue(key: string): void {
		if (key === this.key || this.queue.includes(key)) return;
		this.queue.push(key);
		this.render();
	}

	async onOpen(): Promise<void> {
		this.plugin.modalStash.track(this);
		await this.load();
		if (!this.rec || !this.entity) {
			await this.advance();
			return;
		}
		this.render();
	}

	async onStashRestore(): Promise<void> {
		await this.load();
		this.render();
	}

	private async load(): Promise<void> {
		const [progress, entities] = await Promise.all([
			this.plugin.store.readReciteProgress(),
			this.plugin.store.readEntities(),
		]);
		this.rec = progress.get(this.key) ?? null;
		this.entity = this.rec
			? entities.get(this.rec.entity) ?? null
			: null;
	}

	private label(lang: string): string {
		return (
			this.entity?.labels.find(
				(l) => l.lang === lang && l.text.trim()
			)?.text ?? ""
		);
	}

	private render(): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-recite-reminder");
		this.renderBanner(host);
		const rec = this.rec;
		const entity = this.entity;
		if (!rec || !entity) {
			host.createDiv({ cls: "hl-empty", text: "找不到这个词条。" });
			return;
		}
		const head = host.createDiv({ cls: "hl-lex-ehead hl-study-head" });
		head.createSpan({
			cls: "hl-lex-word",
			text: this.label(rec.from) || rec.entity,
		});
		const fromReading = entity.readings.find(
			(r) => r.lang === rec.from && r.text.trim()
		);
		if (fromReading)
			head.createSpan({ cls: "hl-lex-reading", text: fromReading.text });
		host.createDiv({
			cls: "hl-study-ask",
			text: `${langDisplayName(rec.to)} 怎么说？`,
		});

		const rows = host.createDiv({ cls: "hl-lex-langs hl-study-rows" });
		const row = rows.createDiv({ cls: "hl-lex-lrow hl-study-row is-due" });
		row.createSpan({
			cls: "hl-lex-lname",
			text: langDisplayName(rec.to),
		});
		const word = row.createSpan({
			cls: `hl-lex-answer hl-db-ref${
				this.answerShown ? "" : " hl-db-mask"
			}`,
			text: this.label(rec.to) || rec.entity,
		});
		word.setAttr(
			"aria-label",
			this.answerShown ? "再次遮住" : "点击揭开"
		);
		word.addEventListener("click", () => {
			this.answerShown = !this.answerShown;
			this.render();
		});
		if (this.answerShown) {
			const reading = entity.readings.find(
				(r) => r.lang === rec.to && r.text.trim()
			);
			if (reading)
				row.createSpan({ cls: "hl-lex-reading", text: reading.text });
			const audio = entity.audios.find((a) => a.lang === rec.to);
			if (audio) {
				const play = row.createSpan({ cls: "hl-lex-audio" });
				setIcon(play, "volume-2");
				play.setAttr("aria-label", "播放发音");
				play.addEventListener("click", () =>
					playEntityAudio(this.plugin, audio.link)
				);
			}
			const side = row.createDiv({ cls: "hl-study-row-side" });
			for (const [result, label] of [
				["remembered", "记得"],
				["forgot", "忘了"],
			] as const) {
				const link = side.createSpan({
					cls: `hl-study-link is-${result}`,
					text: label,
				});
				link.addEventListener("click", () => void this.rate(result));
			}
		}
	}

	private renderBanner(host: HTMLElement): void {
		const banner = host.createDiv({ cls: "hl-quiz-reminder-banner" });
		const label = banner.createSpan({ cls: "hl-quiz-reminder-label" });
		const bell = label.createSpan();
		setIcon(bell, "alarm-clock");
		const total = this.queue.length + 1;
		label.createSpan({
			text: total > 1 ? `重温提醒 · 共 ${total} 个词条` : "重温提醒",
		});
		const actions = banner.createDiv({ cls: "hl-quiz-reminder-actions" });
		const minutes = this.snoozeMinutes();
		const snooze = actions.createEl("button", {
			text: `顺延 ${minutes} 分钟`,
		});
		snooze.setAttr("aria-label", "这个词条稍后再提醒");
		snooze.addEventListener("click", () => void this.snooze(minutes));
		const later = actions.createEl("button", { text: "稍后再说" });
		later.setAttr("aria-label", "关闭提醒，词条留在到期队列");
		later.addEventListener("click", () => this.close());
	}

	private snoozeMinutes(): number {
		const schedule = quizSchedule(this.plugin.settings);
		const base = this.rec?.pendingRecheck
			? schedule.recheckMinutes
			: schedule.retryMinutes;
		return Math.max(1, base);
	}

	private async snooze(minutes: number): Promise<void> {
		if (!this.rec) {
			await this.advance();
			return;
		}
		const updated: ReciteProgress = {
			...this.rec,
			nextReview: addMinutes(new Date(), minutes),
			updated: new Date().toISOString(),
		};
		await this.plugin.store.upsertReciteProgress([updated]);
		this.plugin.remindReciteWhenReady(updated);
		await this.advance();
	}

	private async rate(result: "remembered" | "forgot"): Promise<void> {
		if (!this.rec) return;
		const schedule = quizSchedule(this.plugin.settings);
		const updated = reviewProgress(
			this.rec,
			result,
			new Date(),
			schedule
		);
		await this.plugin.store.upsertReciteProgress([updated]);
		this.plugin.remindReciteWhenReady(updated);
		new Notice(
			rateNotice(
				toQuizShape(updated),
				this.plugin.settings.quizMasterySteps,
				schedule
			)
		);
		await this.advance();
	}

	// Move to the next due direction in the queue, or close when it runs dry.
	private async advance(): Promise<void> {
		const next = this.queue.shift();
		if (!next) {
			this.close();
			return;
		}
		this.key = next;
		this.answerShown = false;
		await this.load();
		const schedule = quizSchedule(this.plugin.settings);
		if (
			!this.rec ||
			!this.entity ||
			this.rec.status !== "active" ||
			!isProgressDue(this.rec, new Date(), schedule)
		) {
			await this.advance();
			return;
		}
		this.render();
	}

	onClose(): void {
		this.plugin.modalStash.untrack(this);
		this.contentEl.empty();
		this.onClosed?.();
	}
}
