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
	newProgress,
	reviewProgress,
} from "./recite-progress";

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
		this.onRecord(
			reviewProgress(base, result, new Date(), this.schedule)
		);
		if (item.langs.every((l) => !l.due || l.rated)) this.index++;
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
	handleKey(ev: KeyboardEvent): boolean {
		if (
			this.revealed &&
			(ev.key === " " || ev.code === "Space") &&
			!this.finished()
		) {
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

	protected renderSummary(host: HTMLElement): void {
		const card = host.createDiv({
			cls: "hl-player-card hl-player-summary",
		});
		card.createEl("h2", { text: "背诵完成" });
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
		const done = card.createEl("button", {
			cls: "mod-cta",
			text: "返回",
		});
		done.addEventListener("click", () => this.onExit());
	}
}
