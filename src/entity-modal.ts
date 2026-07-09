import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName } from "./db-format";
import { entitySearchText } from "./db-marker";
import { LiveEditor } from "./live-editor";

// One language's slice of an entity, edited as a card: spellings (comma =
// aliases), transcription, and a pronunciation audio attachment.
interface LangCard {
	lang: string;
	labels: string;
	reading: string;
	audio: string;
}

function toCards(e: EntityEntry, presetFirst: string[]): LangCard[] {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const l of [
		...e.labels.map((x) => x.lang),
		...e.readings.map((x) => x.lang),
		...e.audios.map((x) => x.lang),
	]) {
		if (!seen.has(l)) {
			seen.add(l);
			order.push(l);
		}
	}
	if (!order.length && presetFirst.length) order.push(presetFirst[0]);
	return order.map((lang) => ({
		lang,
		labels: e.labels
			.filter((x) => x.lang === lang)
			.map((x) => x.text)
			.join(", "),
		reading: e.readings
			.filter((x) => x.lang === lang)
			.map((x) => x.text)
			.join(", "),
		audio: e.audios
			.filter((x) => x.lang === lang)
			.map((x) => x.link)
			.join(", "),
	}));
}

function fromCards(e: EntityEntry, cards: LangCard[]): void {
	const split = (s: string): string[] =>
		s
			.split(/[,，]/)
			.map((x) => x.trim())
			.filter((x) => x.length > 0);
	e.labels = [];
	e.readings = [];
	e.audios = [];
	for (const c of cards) {
		if (!c.lang) continue;
		for (const t of split(c.labels)) e.labels.push({ lang: c.lang, text: t });
		for (const t of split(c.reading))
			e.readings.push({ lang: c.lang, text: t });
		for (const t of split(c.audio)) e.audios.push({ lang: c.lang, link: t });
	}
}

// Edit one entity entry: type pill, per-language cards, tag chips and free
// markdown notes. Auto-saves on a debounce; audio attachments can be pasted
// into or dropped onto a language card.
export class EntityModal extends Modal {
	private entity: EntityEntry;
	private cards: LangCard[] = [];
	private types: DbType[] = [];
	private statusEl?: HTMLElement;
	private headEl?: HTMLElement;
	private saveTimer: number | null = null;
	private dirty = false;
	private everSaved = false;
	private notified = false;
	private notes?: LiveEditor;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		entity: EntityEntry,
		private isNew: boolean,
		private onSaved?: (e: EntityEntry) => void
	) {
		super(app);
		this.entity = JSON.parse(JSON.stringify(entity)) as EntityEntry;
	}

	async onOpen(): Promise<void> {
		this.types = await this.plugin.store.readDbTypes();
		if (!this.entity.type) this.entity.type = this.types[0]?.name ?? "";
		this.cards = toCards(this.entity, this.plugin.settings.entityLangs);
		this.render();
	}

	private typeColor(name: string): string | null {
		return this.types.find((t) => t.name === name)?.color ?? null;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hl-entity-modal");
		const e = this.entity;

		// Header: headword + type pill dropdown.
		const head = contentEl.createDiv({ cls: "hl-modal-head" });
		this.headEl = head.createSpan({ cls: "hl-modal-year" });
		this.updateHeadword();
		const pill = head.createEl("select", { cls: "hl-type-pill" });
		for (const t of this.types) pill.createEl("option", { text: t.name, value: t.name });
		if (e.type && !this.types.some((t) => t.name === e.type))
			pill.createEl("option", { text: e.type, value: e.type });
		pill.value = e.type;
		const paintPill = (): void => {
			const c = this.typeColor(pill.value);
			pill.style.color = c ?? "";
			pill.style.borderColor = c ?? "";
		};
		paintPill();
		pill.addEventListener("change", () => {
			e.type = pill.value;
			paintPill();
			this.scheduleSave();
		});

		const body = contentEl.createDiv({ cls: "hl-entity-body-wrap" });

		body.createDiv({ cls: "hl-overline", text: "Languages" });
		const cardsEl = body.createDiv();
		const renderCards = (): void => {
			cardsEl.empty();
			this.cards.forEach((card, i) => this.renderCard(cardsEl, card, i, renderCards));
			const addRow = cardsEl.createDiv({ cls: "hl-lang-add-row" });
			for (const lang of this.plugin.settings.entityLangs) {
				if (this.cards.some((c) => c.lang === lang)) continue;
				const b = addRow.createEl("button", {
					cls: "hl-ghost-btn",
					text: `＋ ${lang.toUpperCase()}`,
				});
				b.addEventListener("click", () => {
					this.cards.push({ lang, labels: "", reading: "", audio: "" });
					renderCards();
				});
			}
			const other = addRow.createEl("button", {
				cls: "hl-ghost-btn",
				text: "＋ 其他语言…",
			});
			other.addEventListener("click", () => {
				const input = addRow.createEl("input", {
					type: "text",
					cls: "hl-lang-new-input",
				});
				input.placeholder = "code";
				input.focus();
				const commit = (): void => {
					const lang = input.value.trim().toLowerCase();
					if (lang && !this.cards.some((c) => c.lang === lang))
						this.cards.push({ lang, labels: "", reading: "", audio: "" });
					renderCards();
				};
				input.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter") commit();
					if (ev.key === "Escape") renderCards();
				});
				input.addEventListener("blur", commit);
			});
		};
		renderCards();

		body.createDiv({ cls: "hl-overline", text: "Tags" });
		this.renderTags(body.createDiv({ cls: "hl-tag-chips" }));

		body.createDiv({ cls: "hl-overline", text: "Notes" });
		const notesEl = body.createDiv({ cls: "hl-entity-notes" });
		this.notes = new LiveEditor(notesEl, {
			value: e.body,
			placeholder: "正文…",
			onChange: (v) => {
				e.body = v;
				this.scheduleSave();
			},
		});

		// Footer: save status, delete, open full page.
		const foot = contentEl.createDiv({ cls: "hl-modal-foot" });
		this.statusEl = foot.createSpan({ cls: "hl-modal-status" });
		if (!this.isNew) {
			const del = foot.createEl("button", {
				cls: "hl-modal-foot-btn hl-danger",
				text: "Delete",
			});
			del.addEventListener("click", async () => {
				await this.plugin.store.removeEntity(e.id);
				this.dirty = false;
				new Notice("Entity deleted (markers in summaries are kept).");
				this.close();
			});
		}
		const open = foot.createEl("button", {
			cls: "hl-modal-foot-btn",
			text: "↗ 打开词条页",
		});
		open.addEventListener("click", async () => {
			await this.flush();
			this.close();
			await this.plugin.openEntityView(e.id);
		});
		const save = foot.createEl("button", {
			cls: "hl-modal-foot-btn hl-primary",
			text: "保存",
		});
		save.addEventListener("click", async () => {
			if (!this.entity.labels.some((l) => l.text.trim())) {
				new Notice("请先填写至少一个词形");
				return;
			}
			this.dirty = true;
			await this.flush();
			this.close();
		});
	}

	private updateHeadword(): void {
		if (!this.headEl) return;
		const name = displayName(this.entity);
		this.headEl.setText(name === this.entity.id ? "未命名" : name);
		this.headEl.toggleClass("hl-placeholder", name === this.entity.id);
	}

	private renderCard(
		parent: HTMLElement,
		card: LangCard,
		index: number,
		rerender: () => void
	): void {
		const el = parent.createDiv({ cls: "hl-lang-card" });

		const head = el.createDiv({ cls: "hl-lang-card-head" });
		head.createSpan({ cls: "hl-lang-badge", text: card.lang.toUpperCase() });
		const del = head.createEl("button", { cls: "hl-row-del", text: "✕" });
		del.addEventListener("click", () => {
			this.cards.splice(index, 1);
			this.syncCards();
			rerender();
		});

		const row = (label: string): HTMLInputElement => {
			const r = el.createDiv({ cls: "hl-lang-row" });
			r.createSpan({ cls: "hl-lang-row-label", text: label });
			return r.createEl("input", { type: "text", cls: "hl-lang-row-input" });
		};

		const labels = row("词形");
		labels.placeholder = "词形";
		labels.value = card.labels;
		labels.addEventListener("input", () => {
			card.labels = labels.value;
			this.syncCards();
		});

		const reading = row("音标");
		reading.value = card.reading;
		reading.addEventListener("input", () => {
			card.reading = reading.value;
			this.syncCards();
		});

		const audioRow = el.createDiv({ cls: "hl-lang-row" });
		audioRow.createSpan({ cls: "hl-lang-row-label", text: "发音" });
		const audio = audioRow.createEl("input", {
			type: "text",
			cls: "hl-lang-row-input",
		});
		audio.placeholder = "拖入或粘贴音频";
		audio.value = card.audio;
		audio.addEventListener("input", () => {
			card.audio = audio.value;
			this.syncCards();
		});
		const play = audioRow.createEl("button", {
			cls: "hl-play-btn",
			text: "▶",
		});
		play.setAttr("aria-label", "Play audio");
		play.addEventListener("click", () => {
			const first = card.audio.split(/[,，]/)[0]?.trim();
			if (first) this.playAudio(first);
		});

		// Audio import: paste into the field or drop onto the card.
		audio.addEventListener("paste", (ev) => {
			const file = ev.clipboardData?.files?.[0];
			if (file && file.type.startsWith("audio/")) {
				ev.preventDefault();
				void this.importAudio(file, card, audio);
			}
		});
		el.addEventListener("dragover", (ev) => {
			ev.preventDefault();
			el.addClass("is-dragover");
		});
		el.addEventListener("dragleave", () => el.removeClass("is-dragover"));
		el.addEventListener("drop", (ev) => {
			el.removeClass("is-dragover");
			const file = ev.dataTransfer?.files?.[0];
			if (file && file.type.startsWith("audio/")) {
				ev.preventDefault();
				void this.importAudio(file, card, audio);
			}
		});
	}

	private async importAudio(
		file: File,
		card: LangCard,
		input: HTMLInputElement
	): Promise<void> {
		const path = await this.app.fileManager.getAvailablePathForAttachment(
			file.name
		);
		await this.app.vault.createBinary(path, await file.arrayBuffer());
		const link = `[[${path}]]`;
		card.audio = card.audio.trim() ? `${card.audio.trim()}, ${link}` : link;
		input.value = card.audio;
		this.syncCards();
		new Notice(`音频已保存：${path}`);
	}

	private renderTags(host: HTMLElement): void {
		host.empty();
		this.entity.tags.forEach((tag, i) => {
			const chip = host.createSpan({ cls: "hl-tag-chip", text: tag });
			const x = chip.createSpan({ cls: "hl-tag-chip-x", text: "✕" });
			x.addEventListener("click", () => {
				this.entity.tags.splice(i, 1);
				this.scheduleSave();
				this.renderTags(host);
			});
		});
		const input = host.createEl("input", {
			type: "text",
			cls: "hl-tag-chip-input",
		});
		input.placeholder = this.entity.tags.length ? "" : "＋ tag";
		const commit = (): void => {
			const v = input.value.trim().replace(/[,，]$/, "").trim();
			if (v && !this.entity.tags.includes(v)) {
				this.entity.tags.push(v);
				this.scheduleSave();
				this.renderTags(host);
				const next = host.querySelector("input");
				(next as HTMLInputElement | null)?.focus();
			} else input.value = "";
		};
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === ",") {
				ev.preventDefault();
				commit();
			}
			if (
				ev.key === "Backspace" &&
				!input.value &&
				this.entity.tags.length
			) {
				this.entity.tags.pop();
				this.scheduleSave();
				this.renderTags(host);
				(host.querySelector("input") as HTMLInputElement | null)?.focus();
			}
		});
		input.addEventListener("blur", () => {
			if (input.value.trim()) commit();
		});
	}

	private syncCards(): void {
		fromCards(this.entity, this.cards);
		this.updateHeadword();
		this.scheduleSave();
	}

	private scheduleSave(): void {
		this.dirty = true;
		this.setStatus("typing");
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.save(), 600);
	}

	private async save(): Promise<void> {
		if (!this.dirty) return;
		if (!this.entity.labels.some((l) => l.text.trim())) return;
		this.dirty = false;
		await this.plugin.store.upsertEntity(this.entity);
		this.everSaved = true;
		this.setStatus("saved");
	}

	private async flush(): Promise<void> {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		await this.save();
		if (this.everSaved && !this.notified) {
			this.notified = true;
			this.onSaved?.(this.entity);
		}
	}

	private setStatus(state: "typing" | "saved"): void {
		if (!this.statusEl) return;
		this.statusEl.empty();
		this.statusEl.createSpan({
			cls: `hl-status-dot ${state === "saved" ? "is-saved" : "is-typing"}`,
		});
		this.statusEl.createSpan({
			text: state === "saved" ? "已自动保存" : "输入中…",
		});
	}

	private playAudio(link: string): void {
		const path = link.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
		const file = this.app.metadataCache.getFirstLinkpathDest(path, "");
		if (!(file instanceof TFile)) {
			new Notice(`Audio attachment not found: ${link}`);
			return;
		}
		void new Audio(this.app.vault.getResourcePath(file)).play();
	}

	onClose(): void {
		void this.flush();
		this.notes?.destroy();
		this.contentEl.empty();
	}
}

// Fuzzy picker across every entity, searching all labels / readings / tags.
export class EntitySuggestModal extends FuzzySuggestModal<EntityEntry> {
	constructor(
		app: App,
		private entities: EntityEntry[],
		private onPick: (e: EntityEntry) => void
	) {
		super(app);
		this.setPlaceholder("Link to entity…");
	}

	getItems(): EntityEntry[] {
		return this.entities;
	}

	getItemText(e: EntityEntry): string {
		return entitySearchText(e);
	}

	renderSuggestion(item: { item: EntityEntry }, el: HTMLElement): void {
		el.createSpan({ text: displayName(item.item) });
		el.createSpan({
			cls: "hl-entity-suggest-meta",
			text: ` ${item.item.type} · ${item.item.labels
				.map((l) => l.text)
				.join(" / ")}`,
		});
	}

	onChooseItem(e: EntityEntry): void {
		this.onPick(e);
	}
}

// Minimal manager for the type list: rename, recolor, add, remove.
export class DbTypeManagerModal extends Modal {
	private types: DbType[] = [];

	constructor(app: App, private plugin: HistoryLoggingPlugin) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.types = await this.plugin.store.readDbTypes();
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hl-db-types-modal");
		contentEl.createEl("h3", { text: "Entity types" });
		const list = contentEl.createDiv({ cls: "hl-entity-rows" });
		this.types.forEach((t, i) => {
			const row = list.createDiv({ cls: "hl-entity-row" });
			const name = row.createEl("input", { type: "text" });
			name.addClass("hl-entity-text");
			name.value = t.name;
			name.addEventListener("input", () => (t.name = name.value.trim()));
			const color = row.createEl("input", { type: "color" });
			color.value = t.color;
			color.addEventListener("input", () => (t.color = color.value));
			const del = row.createEl("button", { text: "×", cls: "hl-row-del" });
			del.addEventListener("click", () => {
				this.types.splice(i, 1);
				this.render();
			});
		});
		const add = contentEl.createEl("button", {
			text: "+ type",
			cls: "hl-row-add",
		});
		add.addEventListener("click", () => {
			this.types.push({ name: "", color: "#888888" });
			this.render();
		});
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					const clean = this.types.filter((t) => t.name.length > 0);
					await this.plugin.store.writeDbTypes(clean);
					new Notice("Entity types saved");
					this.close();
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
