// In-view entity-recitation session: front shows the source-language
// spelling (with optional masked context hints from enabled-tag notes), the
// back reveals target-language spellings, readings and pronunciation. Phase
// 1 keeps no schedule — a one-off shuffled run ending in a tally.

import type HistoryLoggingPlugin from "./main";
import { EntityEntry, orderLangs } from "./db-format";
import { ReciteDeck } from "./recite-format";
import { langDisplayName, playEntityAudio } from "./quiz-render";
import { ContextHint, contextHintsFor } from "./recite-context";
import { PlayerPage } from "./player-shell";
import { shuffle } from "./session-queue";

export class RecitePlayerPage extends PlayerPage {
	private cards: EntityEntry[] = [];
	private index = 0;
	private results = { remembered: 0, forgot: 0 };
	private weak = new Set<string>();
	private hints = new Map<string, ContextHint[]>();
	private hintIndex = 0;
	private hintShown = false;

	constructor(
		plugin: HistoryLoggingPlugin,
		private deck: ReciteDeck,
		candidates: EntityEntry[],
		onExit: () => void
	) {
		super(plugin, deck.name, onExit);
		this.cards = shuffle(candidates);
	}

	protected done(): number {
		return this.index;
	}

	protected total(): number {
		return this.cards.length;
	}

	protected finished(): boolean {
		return this.index >= this.cards.length;
	}

	protected headExtra(head: HTMLElement): void {
		head.createSpan({
			cls: "hl-recite-dir",
			text: `${langDisplayName(this.deck.from)} → ${orderLangs(
				this.deck.to
			)
				.map(langDisplayName)
				.join(" / ")}`,
		});
	}

	private label(e: EntityEntry, lang: string): string | undefined {
		return e.labels.find((l) => l.lang === lang && l.text.trim())?.text;
	}

	private reading(e: EntityEntry, lang: string): string | undefined {
		return e.readings.find((r) => r.lang === lang && r.text.trim())?.text;
	}

	protected renderFront(card: HTMLElement): void {
		const entity = this.cards[this.index];
		if (!entity) return;
		card.createDiv({
			cls: "hl-player-question hl-recite-prompt",
			text: this.label(entity, this.deck.from) ?? entity.id,
		});
		this.renderContextHint(card, entity);
	}

	// Masked occurrence lines as optional context. Lazy: scanned on first
	// request per entity and cached for the session.
	private renderContextHint(card: HTMLElement, entity: EntityEntry): void {
		if (!this.hintShown) {
			const btn = card.createEl("button", {
				cls: "hl-player-hint-btn",
				text: "💡 语境",
			});
			btn.addEventListener("click", () => {
				this.hintShown = true;
				this.render();
			});
			return;
		}
		const box = card.createDiv({ cls: "hl-player-hint hl-recite-context" });
		const cached = this.hints.get(entity.id);
		if (!cached) {
			box.setText("正在查找语境……");
			void contextHintsFor(this.plugin, entity).then((hints) => {
				this.hints.set(entity.id, hints);
				if (box.isConnected) this.render();
			});
			return;
		}
		if (!cached.length) {
			box.setText("没有找到语境出现。");
			return;
		}
		const hint = cached[this.hintIndex % cached.length];
		box.createDiv({ cls: "hl-recite-context-text", text: hint.text });
		const foot = box.createDiv({ cls: "hl-recite-context-foot" });
		foot.createSpan({ text: hint.source });
		if (cached.length > 1) {
			const next = foot.createEl("button", {
				text: `换一条 (${(this.hintIndex % cached.length) + 1}/${
					cached.length
				})`,
			});
			next.addEventListener("click", () => {
				this.hintIndex++;
				this.render();
			});
		}
	}

	protected renderBack(card: HTMLElement): void {
		const entity = this.cards[this.index];
		if (!entity) return;
		card.createDiv({
			cls: "hl-player-question hl-player-question-dim hl-recite-prompt",
			text: this.label(entity, this.deck.from) ?? entity.id,
		});
		const answers = card.createDiv({ cls: "hl-recite-answers" });
		for (const lang of orderLangs(this.deck.to)) {
			const text = this.label(entity, lang);
			if (!text) continue;
			const row = answers.createDiv({ cls: "hl-recite-answer-row" });
			row.createSpan({
				cls: "hl-recite-lang",
				text: langDisplayName(lang),
			});
			row.createSpan({ cls: "hl-recite-word", text });
			const reading = this.reading(entity, lang);
			if (reading)
				row.createSpan({ cls: "hl-recite-reading", text: reading });
			const audio = entity.audios.find((a) => a.lang === lang);
			if (audio) {
				const play = row.createEl("button", {
					cls: "hl-recite-audio",
					text: "▶",
				});
				play.setAttr("aria-label", "播放发音");
				play.addEventListener("click", () =>
					playEntityAudio(this.plugin, audio.link)
				);
			}
		}
	}

	protected renderActions(bar: HTMLElement): void {
		const entity = this.cards[this.index];
		if (!entity) return;
		for (const [result, label, key] of [
			["forgot", "不记得", "1"],
			["remembered", "记得", "2"],
		] as ["forgot" | "remembered", string, string][]) {
			const button = bar.createEl("button", { cls: "hl-player-rate" });
			if (result === "remembered") button.addClass("mod-cta");
			button.createDiv({ text: label });
			button.createDiv({ cls: "hl-player-rate-note", text: key });
			button.addEventListener("click", () => this.rate(entity, result));
		}
	}

	protected rateFromKey(n: number): boolean {
		const entity = this.cards[this.index];
		if (!entity) return false;
		if (n === 1) this.rate(entity, "forgot");
		else if (n === 2) this.rate(entity, "remembered");
		else return false;
		return true;
	}

	private rate(
		entity: EntityEntry,
		result: "forgot" | "remembered"
	): void {
		this.results[result]++;
		if (result === "remembered") this.weak.delete(entity.id);
		else this.weak.add(entity.id);
		this.index++;
		this.revealed = false;
		this.hintShown = false;
		this.hintIndex = 0;
		this.render();
	}

	protected renderSummary(host: HTMLElement): void {
		const card = host.createDiv({
			cls: "hl-player-card hl-player-summary",
		});
		card.createEl("h2", { text: "背诵完成" });
		if (!this.cards.length) {
			card.createDiv({ text: "该方向下没有可背诵的词条。" });
			const done = card.createEl("button", {
				cls: "mod-cta",
				text: "返回",
			});
			done.addEventListener("click", () => this.onExit());
			return;
		}
		card.createDiv({
			cls: "hl-player-summary-time",
			text: `${this.cards.length} 个词条 · 用时 ${this.durationLabel()}`,
		});
		const tallies = card.createDiv({ cls: "hl-player-tallies" });
		const tally = (cls: string, value: number, label: string): void => {
			const box = tallies.createDiv({ cls: `hl-player-tally ${cls}` });
			box.createDiv({ cls: "hl-player-tally-num", text: String(value) });
			box.createDiv({ cls: "hl-player-tally-label", text: label });
		};
		tally("is-ok", this.results.remembered, "记得");
		tally("is-bad", this.results.forgot, "不记得");
		const actions = card.createDiv({ cls: "hl-player-summary-actions" });
		if (this.weak.size) {
			const retry = actions.createEl("button", {
				text: `重练弱项 ${this.weak.size}`,
			});
			retry.addEventListener("click", () => {
				this.cards = shuffle(
					this.cards.filter((c) => this.weak.has(c.id))
				);
				this.weak.clear();
				this.index = 0;
				this.results = { remembered: 0, forgot: 0 };
				this.revealed = false;
				this.startedAt = Date.now();
				this.render();
			});
		}
		const done = actions.createEl("button", {
			cls: this.weak.size ? "" : "mod-cta",
			text: "返回 deck 列表",
		});
		done.addEventListener("click", () => this.onExit());
	}
}
