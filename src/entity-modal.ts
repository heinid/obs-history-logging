import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import {
	DbType,
	EntityEntry,
	displayName,
} from "./db-format";
import { entitySearchText, parseDbMarks, stripDbMarkers } from "./db-marker";
import { parseYearTag } from "./year-tag";

// View / edit one entity entry: type, multi-language labels, readings with
// playable audio, free markdown body, and the list of event summaries the
// entity appears in (its automatically-accumulated chronology).
export class EntityModal extends Modal {
	private entity: EntityEntry;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		entity: EntityEntry,
		private isNew: boolean,
		private onSaved?: (e: EntityEntry) => void
	) {
		super(app);
		// Deep-copy so Cancel discards edits.
		this.entity = JSON.parse(JSON.stringify(entity)) as EntityEntry;
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hl-entity-modal");
		const e = this.entity;
		const types = await this.plugin.store.readDbTypes();

		contentEl.createEl("h3", {
			text: this.isNew ? "New entity" : displayName(e),
		});

		new Setting(contentEl).setName("Type").addDropdown((d) => {
			for (const t of types) d.addOption(t.name, t.name);
			if (e.type && !types.some((t) => t.name === e.type))
				d.addOption(e.type, e.type);
			d.setValue(e.type || types[0]?.name || "");
			e.type = d.getValue();
			d.onChange((v) => (e.type = v));
		});

		// Labels: language + spelling rows. The first row is the display name.
		contentEl.createEl("h5", { text: "Labels (language · spelling)" });
		const labelsEl = contentEl.createDiv({ cls: "hl-entity-rows" });
		const renderLabels = (): void => {
			labelsEl.empty();
			e.labels.forEach((label, i) => {
				const row = labelsEl.createDiv({ cls: "hl-entity-row" });
				const lang = row.createEl("input", { type: "text" });
				lang.addClass("hl-entity-lang");
				lang.placeholder = "lang";
				lang.value = label.lang;
				lang.addEventListener("input", () => (label.lang = lang.value.trim()));
				const text = row.createEl("input", { type: "text" });
				text.addClass("hl-entity-text");
				text.placeholder = "spelling";
				text.value = label.text;
				text.addEventListener("input", () => (label.text = text.value));
				const del = row.createEl("button", { text: "×", cls: "hl-row-del" });
				del.addEventListener("click", () => {
					e.labels.splice(i, 1);
					renderLabels();
				});
			});
			const add = labelsEl.createEl("button", {
				text: "+ label",
				cls: "hl-row-add",
			});
			add.addEventListener("click", () => {
				e.labels.push({ lang: this.plugin.settings.defaultLabelLang, text: "" });
				renderLabels();
			});
		};
		renderLabels();

		// Readings: language + transcription + optional audio attachment.
		contentEl.createEl("h5", { text: "Readings (language · transcription)" });
		const readingsEl = contentEl.createDiv({ cls: "hl-entity-rows" });
		const renderReadings = (): void => {
			readingsEl.empty();
			e.readings.forEach((reading, i) => {
				const row = readingsEl.createDiv({ cls: "hl-entity-row" });
				const lang = row.createEl("input", { type: "text" });
				lang.addClass("hl-entity-lang");
				lang.placeholder = "lang";
				lang.value = reading.lang;
				lang.addEventListener(
					"input",
					() => (reading.lang = lang.value.trim())
				);
				const text = row.createEl("input", { type: "text" });
				text.addClass("hl-entity-text");
				text.placeholder = "transcription (kana / IPA / pinyin…)";
				text.value = reading.text;
				text.addEventListener("input", () => (reading.text = text.value));
				const del = row.createEl("button", { text: "×", cls: "hl-row-del" });
				del.addEventListener("click", () => {
					e.readings.splice(i, 1);
					renderReadings();
				});
			});
			const add = readingsEl.createEl("button", {
				text: "+ reading",
				cls: "hl-row-add",
			});
			add.addEventListener("click", () => {
				e.readings.push({
					lang: this.plugin.settings.defaultLabelLang,
					text: "",
				});
				renderReadings();
			});
		};
		renderReadings();

		contentEl.createEl("h5", { text: "Audio (language · [[attachment]])" });
		const audiosEl = contentEl.createDiv({ cls: "hl-entity-rows" });
		const renderAudios = (): void => {
			audiosEl.empty();
			e.audios.forEach((audio, i) => {
				const row = audiosEl.createDiv({ cls: "hl-entity-row" });
				const lang = row.createEl("input", { type: "text" });
				lang.addClass("hl-entity-lang");
				lang.placeholder = "lang";
				lang.value = audio.lang;
				lang.addEventListener("input", () => (audio.lang = lang.value.trim()));
				const link = row.createEl("input", { type: "text" });
				link.addClass("hl-entity-text");
				link.placeholder = "[[pronunciation.mp3]]";
				link.value = audio.link;
				link.addEventListener("input", () => (audio.link = link.value.trim()));
				const play = row.createEl("button", { text: "▶", cls: "hl-row-play" });
				play.setAttr("aria-label", "Play audio");
				play.addEventListener("click", () => this.playAudio(audio.link));
				const del = row.createEl("button", { text: "×", cls: "hl-row-del" });
				del.addEventListener("click", () => {
					e.audios.splice(i, 1);
					renderAudios();
				});
			});
			const add = audiosEl.createEl("button", {
				text: "+ audio",
				cls: "hl-row-add",
			});
			add.addEventListener("click", () => {
				e.audios.push({
					lang: this.plugin.settings.defaultLabelLang,
					link: "",
				});
				renderAudios();
			});
		};
		renderAudios();

		new Setting(contentEl).setName("Tags").addText((t) => {
			t.setPlaceholder("comma, separated")
				.setValue(e.tags.join(", "))
				.onChange(
					(v) =>
						(e.tags = v
							.split(",")
							.map((s) => s.trim())
							.filter((s) => s.length > 0))
				);
		});

		contentEl.createEl("h5", { text: "Notes" });
		const body = contentEl.createEl("textarea", { cls: "hl-entity-body" });
		body.rows = 5;
		body.placeholder = "Free markdown narrative…";
		body.value = e.body;
		body.addEventListener("input", () => (e.body = body.value));

		if (!this.isNew) await this.renderOccurrences(contentEl);

		const controls = new Setting(contentEl);
		controls.addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					e.labels = e.labels.filter((l) => l.text.trim().length > 0);
					e.readings = e.readings.filter((r) => r.text.trim().length > 0);
					e.audios = e.audios.filter((a) => a.link.trim().length > 0);
					if (!e.labels.length) {
						new Notice("An entity needs at least one label.");
						return;
					}
					await this.plugin.store.upsertEntity(e);
					this.onSaved?.(e);
					this.close();
				})
		);
		if (!this.isNew)
			controls.addButton((b) =>
				b.setButtonText("Delete").onClick(async () => {
					await this.plugin.store.removeEntity(e.id);
					new Notice("Entity deleted (markers in summaries are kept).");
					this.close();
				})
			);
		controls.addButton((b) =>
			b.setButtonText("Cancel").onClick(() => this.close())
		);
	}

	// Everywhere the entity was annotated, sorted chronologically — the
	// entity's own emergent timeline.
	private async renderOccurrences(parent: HTMLElement): Promise<void> {
		const events = await this.plugin.store.readEvents();
		const hits: { evId: string; tag: string; snippet: string; key: number }[] =
			[];
		for (const [evId, ev] of events) {
			if (!parseDbMarks(ev.summary).some((m) => m.id === this.entity.id))
				continue;
			const key = ev.tag ? parseYearTag(ev.tag)?.sortKey ?? 0 : 0;
			const snippet = stripDbMarkers(ev.summary)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 120);
			hits.push({ evId, tag: ev.tag ?? "", snippet, key });
		}
		hits.sort((a, b) => a.key - b.key);
		parent.createEl("h5", { text: `Occurrences (${hits.length})` });
		const list = parent.createDiv({ cls: "hl-entity-occurrences" });
		if (!hits.length) {
			list.createDiv({
				cls: "hl-entity-occ-empty",
				text: "Not annotated in any event summary yet.",
			});
			return;
		}
		for (const hit of hits) {
			const row = list.createDiv({ cls: "hl-entity-occ" });
			row.createSpan({ cls: "hl-tag", text: hit.tag });
			row.createSpan({ cls: "hl-entity-occ-snippet", text: hit.snippet });
			row.addEventListener("click", () => {
				this.close();
				this.plugin.openSummary(hit.evId, hit.tag);
			});
		}
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

	renderSuggestion(
		item: { item: EntityEntry },
		el: HTMLElement
	): void {
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
