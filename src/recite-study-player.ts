// In-view study session for entity recitation with persistent progress.
// The front asks an explicit question («希腊» 的 English / 日本語 怎么说？);
// the back lists one row per target language, each rated on its own —
// results land on the per-«entity × language» progress records, so a word
// can be mastered in English while still learning in Japanese.

import { setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EntityEntry, orderLangs } from "./db-format";
import { QuizSchedule } from "./quiz";
import {
	DbColors,
	langDisplayName,
	playEntityAudio,
} from "./quiz-render";
import { PlayerPage } from "./player-shell";
import { shuffle } from "./session-queue";
import { ContextHint, renderContextMarkdown } from "./recite-context";
import {
	ReciteProgress,
	isProgressDue,
	newProgress,
	progressKey,
	reviewProgress,
} from "./recite-progress";
import { EntityModal } from "./entity-modal";

export interface StudyLang {
	lang: string;
	due: boolean;
	progress?: ReciteProgress;
	rated?: "remembered" | "forgot";
	revealed?: boolean;
}

export interface StudyItem {
	entity: EntityEntry;
	langs: StudyLang[];
}

export class StudyPlayerPage extends PlayerPage {
	private items: StudyItem[] = [];
	private index = 0;
	private results = { remembered: 0, forgot: 0 };
	private ctxIdx = new Map<string, number>();
	// Cards with forgotten rows sitting out the short retry wait; they are
	// interjected back into the queue once due — the session only ends when
	// every row has been passed with “记得” (same promise as the event quiz).
	private pending: StudyItem[] = [];
	private waitMode = false;
	private watchTimer = 0;

	constructor(
		plugin: HistoryLoggingPlugin,
		deckLabel: string,
		private from: string,
		items: StudyItem[],
		private schedule: QuizSchedule,
		private onRecord: (rec: ReciteProgress) => void,
		onExit: () => void,
		private contexts: Map<string, ContextHint[]> = new Map(),
		private colors: DbColors = new Map()
	) {
		super(plugin, deckLabel, onExit);
		this.items = shuffle(items);
		// The dictionary-style card masks answers in place, so there is no
		// separate front / “show answer” step.
		this.revealed = true;
		this.watchTimer = window.setInterval(() => this.poll(), 5_000);
	}

	unmount(): void {
		window.clearInterval(this.watchTimer);
		super.unmount();
	}

	// Rows sitting out a short wait: forgotten ones on their retry, plus
	// first-learn rechecks — both come back into the queue once due.
	private retrySlots(item: StudyItem): StudyLang[] {
		return item.langs.filter(
			(l) =>
				l.due &&
				(l.rated === "forgot" ||
					(l.rated === "remembered" &&
						l.progress?.pendingRecheck))
		);
	}

	// A direction came off its short wait while this session is running;
	// consume it when the card is in our waiting pool.
	handleDueDirection(key: string): boolean {
		const owns = this.pending.some((it) =>
			this.retrySlots(it).some(
				(l) =>
					progressKey(it.entity.id, this.from, l.lang) === key
			)
		);
		if (owns) this.poll();
		return owns;
	}

	// Move pending cards whose retry wait has elapsed back into the queue,
	// right after the current card.
	private poll(force = false): void {
		if (!this.pending.length) return;
		const now = new Date();
		const ready = this.pending.filter(
			(it) =>
				force ||
				this.retrySlots(it).every((l) =>
					isProgressDue(l.progress, now, this.schedule)
				)
		);
		if (!ready.length) return;
		this.pending = this.pending.filter((it) => !ready.includes(it));
		for (const it of ready) {
			for (const l of this.retrySlots(it)) {
				l.rated = undefined;
				l.revealed = false;
			}
			this.items.splice(
				Math.min(this.index + 1, this.items.length),
				0,
				it
			);
		}
		this.waitMode = false;
		this.render();
	}

	protected done(): number {
		return this.index;
	}

	protected total(): number {
		return this.items.length;
	}

	protected finished(): boolean {
		return this.index >= this.items.length;
	}

	private label(e: EntityEntry, lang: string): string | undefined {
		return e.labels.find((l) => l.lang === lang && l.text.trim())?.text;
	}

	protected renderFront(card: HTMLElement): void {
		const item = this.items[this.index];
		if (!item) return;
		card.createDiv({
			cls: "hl-player-question hl-recite-prompt",
			text: this.label(item.entity, this.from) ?? item.entity.id,
		});
		const due = item.langs.filter((l) => l.due);
		const ask = due.length ? due : item.langs;
		card.createDiv({
			cls: "hl-study-ask",
			text: `${orderLangs(ask.map((l) => l.lang))
				.map(langDisplayName)
				.join(" / ")} 怎么说？`,
		});
	}

	protected renderBack(card: HTMLElement): void {
		const item = this.items[this.index];
		if (!item) return;
		const head = card.createDiv({ cls: "hl-lex-ehead hl-study-head" });
		head.createSpan({
			cls: "hl-lex-word",
			text: this.label(item.entity, this.from) ?? item.entity.id,
		});
		const reading = item.entity.readings.find(
			(r) => r.lang === this.from && r.text.trim()
		);
		if (reading)
			head.createSpan({
				cls: "hl-lex-reading",
				text: reading.text,
			});
		const edit = head.createSpan({ cls: "hl-study-edit" });
		setIcon(edit, "pencil");
		edit.setAttr("aria-label", "编辑词条 (E)");
		edit.addEventListener("click", () => this.editCurrent());
		const rows = card.createDiv({ cls: "hl-lex-langs hl-study-rows" });
		const ordered = orderLangs(item.langs.map((l) => l.lang));
		for (const lang of ordered) {
			const slot = item.langs.find((l) => l.lang === lang);
			if (!slot) continue;
			this.renderRow(rows, item, slot);
		}
		this.renderContext(card, item.entity);
	}

	private renderContext(card: HTMLElement, e: EntityEntry): void {
		const hints = this.contexts.get(e.id) ?? [];
		if (!hints.length) return;
		const idx = (this.ctxIdx.get(e.id) ?? 0) % hints.length;
		const hint = hints[idx];
		const box = card.createDiv({ cls: "hl-lex-ctx hl-study-ctx" });
		const quote = box.createSpan({ cls: "hl-lex-ctx-q is-open" });
		quote.createSpan({ cls: "hl-lex-ctx-mark", text: "「" });
		renderContextMarkdown(
			this.plugin,
			hint.raw,
			e.id,
			quote.createSpan({ cls: "hl-lex-ctx-body" }),
			this.colors,
			hint.kind === "note" ? hint.path : ""
		);
		quote.createSpan({ cls: "hl-lex-ctx-mark", text: "」" });
		if (hints.length > 1) {
			const pager = box.createSpan({
				cls: "hl-lex-ctx-pager",
				text: `${idx + 1} / ${hints.length} ›`,
			});
			pager.setAttr("aria-label", "换一条语境");
			pager.addEventListener("click", () => {
				this.ctxIdx.set(e.id, idx + 1);
				this.render();
			});
		}
	}

	private renderRow(
		host: HTMLElement,
		item: StudyItem,
		slot: StudyLang
	): void {
		const row = host.createDiv({
			cls: `hl-lex-lrow hl-study-row${slot.due ? " is-due" : " is-rest"}${
				slot.rated ? ` is-${slot.rated}` : ""
			}`,
		});
		row.createSpan({
			cls: "hl-lex-lname",
			text: langDisplayName(slot.lang),
		});
		const text = this.label(item.entity, slot.lang) ?? "";
		// The answer sits in place under the standard cloze blur; clicking
		// reveals, clicking the revealed word (before rating) re-masks.
		const word = row.createSpan({
			cls: `hl-lex-answer hl-db-ref${
				slot.revealed ? "" : " hl-db-mask"
			}`,
			text,
		});
		word.setAttr("aria-label", slot.revealed ? "再次遮住" : "点击揭开");
		word.addEventListener("click", () => {
			if (slot.rated) return;
			slot.revealed = !slot.revealed;
			this.render();
		});
		if (slot.revealed) {
			const reading = item.entity.readings.find(
				(r) => r.lang === slot.lang && r.text.trim()
			);
			if (reading)
				row.createSpan({
					cls: "hl-lex-reading",
					text: reading.text,
				});
			const audio = item.entity.audios.find(
				(a) => a.lang === slot.lang
			);
			if (audio) {
				const play = row.createSpan({ cls: "hl-lex-audio" });
				setIcon(play, "volume-2");
				play.setAttr("aria-label", "播放发音");
				play.addEventListener("click", () =>
					playEntityAudio(this.plugin, audio.link)
				);
			}
		}
		const side = row.createDiv({ cls: "hl-study-row-side" });
		if (slot.rated) {
			const mark = side.createSpan({
				cls: `hl-study-rated is-${slot.rated}`,
			});
			setIcon(mark, slot.rated === "remembered" ? "check" : "x");
		} else if (slot.revealed && slot.due) {
			for (const [result, label] of [
				["remembered", "记得"],
				["forgot", "忘了"],
			] as const) {
				const link = side.createSpan({
					cls: `hl-study-link is-${result}`,
					text: label,
				});
				link.addEventListener("click", () =>
					this.rate(item, slot, result)
				);
			}
		}
		this.renderDots(side, slot);
	}

	private renderDots(side: HTMLElement, slot: StudyLang): void {
		const steps = Math.max(1, this.schedule.masterySteps);
		const p =
			slot.progress?.status === "mastered"
				? steps
				: slot.progress?.progress ?? 0;
		const dots = side.createSpan({ cls: "hl-lex-dots" });
		for (let i = 0; i < steps; i++)
			dots.createSpan({ cls: `hl-lex-dot${i < p ? " is-f" : ""}` });
		if (slot.progress?.status === "mastered") dots.addClass("is-done");
		dots.setAttr(
			"aria-label",
			slot.due ? `掌握 ${p}/${steps}` : "该方向暂不到期"
		);
	}

	private rate(
		item: StudyItem,
		slot: StudyLang,
		result: "remembered" | "forgot"
	): void {
		if (slot.rated) return;
		slot.rated = result;
		this.results[result]++;
		const base =
			slot.progress ??
			newProgress(item.entity.id, this.from, slot.lang);
		const rec = reviewProgress(base, result, new Date(), this.schedule);
		slot.progress = rec;
		this.onRecord(rec);
		if (item.langs.every((l) => !l.due || l.rated)) {
			if (this.retrySlots(item).length) this.pending.push(item);
			this.index++;
			if (this.finished() && this.pending.length)
				this.waitMode = true;
		}
		this.render();
	}

	// 1 = forgot, 2 = remembered, applied to the first revealed unrated due
	// row (space reveals the card, clicks reveal rows).
	protected rateFromKey(n: number): boolean {
		const item = this.items[this.index];
		if (!item) return false;
		const slot = item.langs.find(
			(l) => l.due && !l.rated && l.revealed
		);
		if (!slot) {
			const hidden = item.langs.find((l) => l.due && !l.rated);
			if (hidden) {
				hidden.revealed = true;
				this.render();
			}
			return !!hidden;
		}
		if (n === 1) this.rate(item, slot, "forgot");
		else if (n === 2) this.rate(item, slot, "remembered");
		else return false;
		return true;
	}

	// Space also reveals the next hidden due row once the card is flipped.
	// E opens the entity editor; A reveals every row (or masks them again).
	handleKey(ev: KeyboardEvent): boolean {
		if (this.finished() || ev.ctrlKey || ev.metaKey || ev.altKey)
			return super.handleKey(ev);
		if (ev.key === "e" || ev.key === "E") {
			this.editCurrent();
			return true;
		}
		if (ev.key === "a" || ev.key === "A") {
			this.toggleAllRows();
			return true;
		}
		if (this.revealed && (ev.key === " " || ev.code === "Space")) {
			const item = this.items[this.index];
			const hidden = item?.langs.find((l) => l.due && !l.revealed);
			if (hidden) {
				hidden.revealed = true;
				this.render();
				return true;
			}
		}
		return super.handleKey(ev);
	}

	private editCurrent(): void {
		const item = this.items[this.index];
		if (!item) return;
		new EntityModal(
			this.plugin.app,
			this.plugin,
			item.entity,
			false,
			(saved) => {
				item.entity = saved;
				this.render();
			}
		).open();
	}

	// Reveal every still-masked unrated row; when all are open, mask back.
	private toggleAllRows(): void {
		const item = this.items[this.index];
		if (!item) return;
		const rows = item.langs.filter((l) => !l.rated);
		if (!rows.length) return;
		const hidden = rows.filter((l) => !l.revealed);
		if (hidden.length) for (const l of hidden) l.revealed = true;
		else for (const l of rows) l.revealed = false;
		this.render();
	}

	protected renderActions(bar: HTMLElement): void {
		const item = this.items[this.index];
		if (!item) return;
		const due = item.langs.filter((l) => l.due);
		const ratedCount = due.filter((l) => l.rated).length;
		bar.createSpan({
			cls: "hl-study-progress-note",
			text: `逐行判分 · ${ratedCount}/${due.length}`,
		});
	}

	// Soonest retry among pending rows, as a rough countdown.
	private waitLabel(): string {
		const times = this.pending
			.flatMap((it) => this.retrySlots(it))
			.map((l) => l.progress?.nextReview)
			.filter((t): t is string => !!t)
			.sort();
		if (!times.length) return "";
		const mins = Math.ceil(
			(Date.parse(times[0]) - Date.now()) / 60_000
		);
		return mins <= 0 ? "马上" : `约 ${mins} 分钟后`;
	}

	protected renderSummary(host: HTMLElement): void {
		const card = host.createDiv({
			cls: "hl-player-card hl-player-summary",
		});
		card.createEl("h2", {
			text: this.waitMode ? "等待重试" : "背诵完成",
		});
		if (!this.items.length) {
			card.createDiv({ text: "没有到期的方向。" });
		} else {
			card.createDiv({
				cls: "hl-player-summary-time",
				text: `${this.items.length} 个词条 · 用时 ${this.durationLabel()}`,
			});
			const tallies = card.createDiv({ cls: "hl-player-tallies" });
			const tally = (
				cls: string,
				value: number,
				label: string
			): void => {
				const box = tallies.createDiv({
					cls: `hl-player-tally ${cls}`,
				});
				box.createDiv({
					cls: "hl-player-tally-num",
					text: String(value),
				});
				box.createDiv({
					cls: "hl-player-tally-label",
					text: label,
				});
			};
			tally("is-ok", this.results.remembered, "记得");
			tally("is-bad", this.results.forgot, "不记得");
		}
		if (this.pending.length) {
			const note = card.createDiv({ cls: "hl-player-wait-note" });
			const label = (): string =>
				`⏰ ${this.pending.length} 张卡在重试等待中 · 最近 ${this.waitLabel()}，到点自动续上`;
			note.setText(label());
			const timer = window.setInterval(() => {
				if (!note.isConnected) {
					window.clearInterval(timer);
					return;
				}
				note.setText(label());
			}, 15_000);
		}
		const actions = card.createDiv({
			cls: "hl-player-summary-actions",
		});
		if (this.pending.length) {
			const retry = actions.createEl("button", {
				text: `提前重测 ${this.pending.length}`,
			});
			retry.addEventListener("click", () => this.poll(true));
		}
		const done = actions.createEl("button", {
			cls: this.pending.length ? "" : "mod-cta",
			text: "返回",
		});
		done.addEventListener("click", () => this.onExit());
	}
}
