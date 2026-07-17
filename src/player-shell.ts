// Shared chrome of the in-view recitation player: top bar (back button,
// title, counter), progress bar, flip card, fixed action bar, toast and
// summary scaffolding. Subclasses fill in the card faces and rating.

import { setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";

export abstract class PlayerPage {
	protected revealed = false;
	protected host: HTMLElement | null = null;
	protected startedAt = Date.now();

	constructor(
		protected plugin: HistoryLoggingPlugin,
		protected deckLabel: string,
		protected onExit: () => void
	) {}

	mount(host: HTMLElement): void {
		this.host = host;
		this.render();
	}

	unmount(): void {
		this.host = null;
	}

	// Answered so far / total, for the header and progress bar.
	protected abstract done(): number;
	protected abstract total(): number;
	protected abstract finished(): boolean;
	protected abstract renderFront(card: HTMLElement): void;
	protected abstract renderBack(card: HTMLElement): void;
	// Action bar under the card, back side only.
	protected abstract renderActions(bar: HTMLElement): void;
	protected abstract renderSummary(host: HTMLElement): void;
	protected headExtra(_head: HTMLElement): void {}
	// Small controls anchored in the footer's side zones (hint toggle,
	// timeline jump…); the card face itself carries content only.
	protected footerExtras(_left: HTMLElement, _right: HTMLElement): void {}

	// Header counter text; subclasses may redefine the semantics.
	protected counterText(): string {
		return `第 ${this.done() + 1} 题 · 共 ${this.total()} 题`;
	}

	// Progress bar segments (fractions of the whole, drawn left to right).
	protected progressSegments(): { cls: string; frac: number }[] {
		const frac = this.total()
			? Math.min(1, this.done() / this.total())
			: 0;
		return [{ cls: "", frac }];
	}

	// Keyboard: space flips, digits rate (delegated to subclass).
	handleKey(ev: KeyboardEvent): boolean {
		if (this.finished()) return false;
		if (ev.key === " " || ev.code === "Space") {
			if (!this.revealed) {
				this.revealed = true;
				this.render();
			}
			return true;
		}
		if (this.revealed && /^[1-3]$/.test(ev.key))
			return this.rateFromKey(Number(ev.key));
		return false;
	}

	protected rateFromKey(_n: number): boolean {
		return false;
	}

	protected render(): void {
		const host = this.host;
		if (!host) return;
		host.empty();
		host.addClass("hl-player");

		const top = host.createDiv({ cls: "hl-player-top" });
		const back = top.createEl("button", { cls: "hl-player-back" });
		setIcon(back, "arrow-left");
		back.createSpan({ text: this.deckLabel });
		back.setAttr("aria-label", "返回 deck 列表");
		back.addEventListener("click", () => this.onExit());
		this.headExtra(top);
		if (!this.finished())
			top.createSpan({
				cls: "hl-player-counter",
				text: this.counterText(),
			});

		// One continuous block: progress bar as the card's top edge, the
		// question body, then a footer bar the buttons are anchored in —
		// nothing floats on empty space.
		const block = host.createDiv({ cls: "hl-player-block" });
		const progress = block.createDiv({ cls: "hl-player-progress" });
		for (const seg of this.progressSegments()) {
			if (seg.frac <= 0) continue;
			progress.createDiv({
				cls: `hl-player-progress-fill ${seg.cls}`,
			}).style.width = `${Math.round(seg.frac * 1000) / 10}%`;
		}

		if (this.finished()) {
			this.renderSummary(block.createDiv({ cls: "hl-player-card" }));
			this.toastEl = host.createDiv({ cls: "hl-player-toast" });
			this.toastEl.hide();
			return;
		}
		const card = block.createDiv({ cls: "hl-player-card" });
		const body = card.createDiv({ cls: "hl-player-body" });
		const footer = card.createDiv({ cls: "hl-player-footer" });
		const left = footer.createDiv({ cls: "hl-player-foot-side" });
		const main = footer.createDiv({ cls: "hl-player-foot-main" });
		const right = footer.createDiv({
			cls: "hl-player-foot-side is-right",
		});
		this.footerExtras(left, right);
		if (!this.revealed) {
			this.renderFront(body);
			const show = main.createEl("button", {
				cls: "mod-cta hl-player-show",
				text: "显示答案",
			});
			show.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
		} else {
			this.renderBack(body);
			this.renderActions(main);
		}
		this.toastEl = host.createDiv({ cls: "hl-player-toast" });
		this.toastEl.hide();
	}

	private toastEl: HTMLElement | null = null;
	private toastTimer = 0;

	protected toast(text: string): void {
		if (!this.toastEl || !this.toastEl.isConnected) return;
		this.toastEl.setText(text);
		this.toastEl.show();
		window.clearTimeout(this.toastTimer);
		this.toastTimer = window.setTimeout(() => {
			this.toastEl?.hide();
		}, 5000);
	}

	protected durationLabel(): string {
		const seconds = Math.round((Date.now() - this.startedAt) / 1000);
		if (seconds < 60) return `${seconds} 秒`;
		return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
	}
}
