import {
	AbstractInputSuggest,
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	TFile,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName, orderLangs } from "./db-format";
import { entitySearchText } from "./db-marker";
import { LiveEditor, registerEscapeFirst } from "./live-editor";
import { ConfirmModal } from "./name-modal";

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
	return orderLangs(order).map((lang) => ({
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
	private saveBtn?: HTMLButtonElement;
	private headEl?: HTMLElement;
	private dirty = false;
	private everSaved = false;
	private notified = false;
	private notes?: LiveEditor;
	private knownTags: string[] = [];

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
		this.plugin.modalStash.track(this);
		// Escape closes the notes editor's completion dropdown / popover
		// first; only a second Escape (nothing open) closes the modal. Must
		// run before the modal's own Escape handler in the scope.
		registerEscapeFirst(this.scope, () =>
			this.notes?.closeSuggestIfOpen() ?? false
		);
		this.types = await this.plugin.store.readDbTypes();
		const all = await this.plugin.store.readEntities();
		this.knownTags = [
			...new Set([...all.values()].flatMap((e) => e.tags)),
		].sort((a, b) => a.localeCompare(b));
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
			this.markDirty();
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
				this.markDirty();
			},
		});

		// Footer: delete, open full page, save.
		const foot = contentEl.createDiv({ cls: "hl-modal-foot" });
		if (!this.isNew) {
			const del = foot.createEl("button", {
				cls: "hl-modal-foot-btn hl-danger",
				text: "Delete",
			});
			del.addEventListener("click", () => {
				new ConfirmModal(
					this.app,
					"删除词条",
					`确定删除「${displayName(e)}」？正文中的标注会保留但将失效。`,
					"删除",
					() =>
						void (async () => {
							await this.plugin.store.removeEntity(e.id);
							this.dirty = false;
							new Notice(`已删除词条「${displayName(e)}」。`);
							this.close();
						})()
				).open();
			});
		}
		const open = foot.createEl("button", {
			cls: "hl-modal-foot-btn",
			text: "↗ 打开词条页",
		});
		open.addEventListener("click", async () => {
			if ((this.dirty || this.isNew) && !(await this.save())) return;
			this.plugin.modalStash.jump(() => this.plugin.openEntityView(e.id));
		});
		const save = foot.createEl("button", {
			cls: "hl-modal-foot-btn hl-primary",
			text: "保存",
		});
		save.addEventListener("click", async () => {
			if (await this.save()) this.close();
		});
		this.saveBtn = save;
		this.paintSaveBtn();
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
				this.markDirty();
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
				this.markDirty();
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
				this.markDirty();
				this.renderTags(host);
				(host.querySelector("input") as HTMLInputElement | null)?.focus();
			}
		});
		input.addEventListener("blur", () => {
			if (input.value.trim()) commit();
		});
		new EntityTagSuggest(
			this.app,
			input,
			() => this.knownTags.filter((t) => !this.entity.tags.includes(t)),
			(tag) => {
				this.entity.tags.push(tag);
				this.markDirty();
				this.renderTags(host);
				(
					host.querySelector("input") as HTMLInputElement | null
				)?.focus();
			}
		);
	}

	private syncCards(): void {
		fromCards(this.entity, this.cards);
		this.updateHeadword();
		this.markDirty();
	}

	// Nothing is written until the user presses "保存"; the save button's
	// enabled state is the only unsaved-edits indicator.
	private markDirty(): void {
		this.dirty = true;
		this.paintSaveBtn();
	}

	private paintSaveBtn(): void {
		if (this.saveBtn) this.saveBtn.disabled = !this.dirty && !this.isNew;
	}

	// Persist explicitly (from the save button). Returns false if invalid.
	private async save(): Promise<boolean> {
		if (!this.entity.labels.some((l) => l.text.trim())) {
			new Notice("请先填写至少一个词形");
			return false;
		}
		await this.plugin.store.upsertEntity(this.entity);
		this.dirty = false;
		this.everSaved = true;
		this.paintSaveBtn();
		if (!this.notified) {
			this.notified = true;
			this.onSaved?.(this.entity);
		}
		return true;
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

	// The form keeps the user's in-progress edits across a stash; only the
	// type list is refreshed.
	async onStashRestore(): Promise<void> {
		this.types = await this.plugin.store.readDbTypes();
	}

	onClose(): void {
		this.plugin.modalStash.untrack(this);
		// Nothing is written unless the user pressed 保存 — closing an
		// unsaved new entity simply discards it.
		this.notes?.destroy();
		this.contentEl.empty();
	}
}

// Completes the tag-chip input against tags already used on other entities,
// so spelling variants don't multiply.
export class EntityTagSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private candidates: () => string[],
		private onPick: (tag: string) => void
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		return this.candidates()
			.filter((t) => t.toLowerCase().includes(q))
			.slice(0, 12);
	}

	renderSuggestion(tag: string, el: HTMLElement): void {
		el.setText(tag);
	}

	selectSuggestion(tag: string): void {
		this.close();
		this.onPick(tag);
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

