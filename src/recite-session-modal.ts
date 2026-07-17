import { App, Modal } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EntityEntry, orderLangs } from "./db-format";
import { ReciteDeck } from "./recite-format";
import { langDisplayName, playEntityAudio } from "./quiz-render";

// Self-graded entity recitation: show the source-language spelling and recall
// the target-language spelling(s). Phase 1 keeps no schedule — a session is a
// one-off shuffled run that ends with a tally.
export class ReciteSessionModal extends Modal {
	private cards: EntityEntry[] = [];
	private index = 0;
	private revealed = false;
	private results = { remembered: 0, forgot: 0 };
	private weak = new Set<string>();

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private deck: ReciteDeck,
		candidates: EntityEntry[]
	) {
		super(app);
		this.cards = shuffle(candidates);
	}

	onOpen(): void {
		this.render();
	}

	private label(e: EntityEntry, lang: string): string | undefined {
		return e.labels.find((l) => l.lang === lang && l.text.trim())?.text;
	}

	private reading(e: EntityEntry, lang: string): string | undefined {
		return e.readings.find((r) => r.lang === lang && r.text.trim())?.text;
	}

	private render(): void {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-quiz-session");
		host.addClass("hl-recite-session");
		if (!this.cards.length || this.index >= this.cards.length) {
			this.renderResults(host);
			return;
		}
		const card = this.cards[this.index];
		const head = host.createDiv({ cls: "hl-quiz-session-head" });
		head.createSpan({
			text: `第 ${this.index + 1} 题，共 ${this.cards.length} 题`,
		});
		head.createSpan({
			cls: "hl-recite-dir",
			text: `${langDisplayName(this.deck.from)} → ${orderLangs(
				this.deck.to
			)
				.map(langDisplayName)
				.join(" / ")}`,
		});

		const prompt = this.label(card, this.deck.from) ?? card.id;
		host.createDiv({ cls: "hl-quiz-practice-question", text: prompt });

		if (!this.revealed) {
			const show = host.createEl("button", {
				cls: "mod-cta hl-quiz-show-answer",
				text: "显示答案",
			});
			show.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
			return;
		}

		const answers = host.createDiv({ cls: "hl-recite-answers" });
		for (const lang of orderLangs(this.deck.to)) {
			const text = this.label(card, lang);
			if (!text) continue;
			const row = answers.createDiv({ cls: "hl-recite-answer-row" });
			row.createSpan({ cls: "hl-recite-lang", text: langDisplayName(lang) });
			row.createSpan({ cls: "hl-recite-word", text });
			const reading = this.reading(card, lang);
			if (reading)
				row.createSpan({ cls: "hl-recite-reading", text: reading });
			const audio = card.audios.find((a) => a.lang === lang);
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

		const actions = host.createDiv({ cls: "hl-quiz-review-actions" });
		for (const [result, text] of [
			["forgot", "不记得"],
			["remembered", "记得"],
		] as ["forgot" | "remembered", string][]) {
			const button = actions.createEl("button", { text });
			if (result === "remembered") button.addClass("mod-cta");
			button.addEventListener("click", () => this.rate(card, result));
		}
	}

	private rate(card: EntityEntry, result: "forgot" | "remembered"): void {
		this.results[result]++;
		if (result === "remembered") this.weak.delete(card.id);
		else this.weak.add(card.id);
		this.index++;
		this.revealed = false;
		this.render();
	}

	private renderResults(host: HTMLElement): void {
		host.createEl("h2", { text: "背诵完成" });
		if (!this.cards.length) {
			host.createDiv({ text: "该方向下没有可背诵的词条。" });
			const done = host.createEl("button", { cls: "mod-cta", text: "关闭" });
			done.addEventListener("click", () => this.close());
			return;
		}
		const summary = host.createDiv({ cls: "hl-quiz-session-results" });
		summary.createDiv({ text: `记得 ${this.results.remembered}` });
		summary.createDiv({ text: `不记得 ${this.results.forgot}` });
		if (this.weak.size) {
			const retry = host.createEl("button", {
				text: `重练 ${this.weak.size} 个`,
			});
			retry.addEventListener("click", () => {
				this.cards = shuffle(
					this.cards.filter((c) => this.weak.has(c.id))
				);
				this.weak.clear();
				this.index = 0;
				this.revealed = false;
				this.results = { remembered: 0, forgot: 0 };
				this.render();
			});
		}
		const done = host.createEl("button", { cls: "mod-cta", text: "完成" });
		done.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function shuffle<T>(items: T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}
