import {
	ItemView,
	MarkdownRenderer,
	Notice,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName } from "./db-format";
import { dbMarkersToHtml, parseDbMarks, stripDbMarkers } from "./db-marker";
import { EntityModal } from "./entity-modal";
import { describeYear, parseYearTag } from "./year-tag";

export const ENTITY_VIEW_TYPE = "history-logging-entity";

// A full tab page for one entity: hero (headword + type pill + id), the
// per-language cards, the free notes and the entity's emergent chronology
// (every event summary it is annotated in, sorted by year).
export class EntityView extends ItemView {
	private entityId = "";
	private entity: EntityEntry | null = null;
	private types: DbType[] = [];

	constructor(leaf: WorkspaceLeaf, private plugin: HistoryLoggingPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ENTITY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.entity ? displayName(this.entity) : "Entity";
	}

	getIcon(): string {
		return "book-open";
	}

	getState(): Record<string, unknown> {
		return { entityId: this.entityId };
	}

	async setState(
		state: unknown,
		result: { history: boolean }
	): Promise<void> {
		const s = state as { entityId?: string } | null;
		if (s?.entityId) {
			this.entityId = s.entityId;
			await this.refresh();
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.entityId) return;
		this.entity =
			(await this.plugin.store.readEntities()).get(this.entityId) ?? null;
		this.types = await this.plugin.store.readDbTypes();
		await this.render();
	}

	private typeColor(name: string): string | null {
		return this.types.find((t) => t.name === name)?.color ?? null;
	}

	private async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("hl-entity-page");
		const e = this.entity;
		if (!e) {
			root.createDiv({
				cls: "hl-entity-occ-empty",
				text: `No entity with id ${this.entityId} in entities.md`,
			});
			return;
		}

		// Hero.
		const hero = root.createDiv({ cls: "hl-page-hero" });
		const heroTop = hero.createDiv({ cls: "hl-page-hero-top" });
		heroTop.createSpan({ cls: "hl-page-headword", text: displayName(e) });
		const pill = heroTop.createSpan({
			cls: "hl-type-pill hl-type-pill-static",
			text: e.type || "?",
		});
		const color = this.typeColor(e.type);
		if (color) {
			pill.style.color = color;
			pill.style.borderColor = color;
		}
		heroTop.createSpan({ cls: "hl-page-id", text: e.id });
		const edit = heroTop.createEl("button", {
			cls: "hl-modal-foot-btn hl-page-edit",
			text: "编辑",
		});
		edit.addEventListener("click", () => {
			new EntityModal(this.app, this.plugin, e, false, () =>
				void this.refresh()
			).open();
		});
		if (e.tags.length) {
			const tags = hero.createDiv({ cls: "hl-page-tags" });
			for (const t of e.tags)
				tags.createSpan({ cls: "hl-tag-chip", text: t });
		}

		// Languages.
		const langs: string[] = [];
		for (const l of [
			...e.labels.map((x) => x.lang),
			...e.readings.map((x) => x.lang),
			...e.audios.map((x) => x.lang),
		])
			if (!langs.includes(l)) langs.push(l);
		if (langs.length) {
			root.createDiv({ cls: "hl-overline", text: "Languages" });
			const grid = root.createDiv({ cls: "hl-page-lang-grid" });
			for (const lang of langs) {
				const card = grid.createDiv({ cls: "hl-lang-card" });
				const head = card.createDiv({ cls: "hl-lang-card-head" });
				head.createSpan({
					cls: "hl-lang-badge",
					text: lang.toUpperCase(),
				});
				const words = e.labels
					.filter((x) => x.lang === lang)
					.map((x) => x.text);
				if (words.length)
					card.createDiv({
						cls: "hl-page-lang-word",
						text: words.join(" · "),
					});
				const readings = e.readings
					.filter((x) => x.lang === lang)
					.map((x) => x.text);
				if (readings.length)
					card.createDiv({
						cls: "hl-page-lang-reading",
						text: readings.join(" · "),
					});
				for (const a of e.audios.filter((x) => x.lang === lang)) {
					const play = card.createEl("button", {
						cls: "hl-play-btn",
						text: "▶",
					});
					play.setAttr("aria-label", a.link);
					play.addEventListener("click", () => this.playAudio(a.link));
				}
			}
		}

		// Notes.
		if (e.body.trim()) {
			root.createDiv({ cls: "hl-overline", text: "Notes" });
			const notes = root.createDiv({ cls: "hl-page-notes" });
			await MarkdownRenderer.render(
				this.app,
				dbMarkersToHtml(e.body, (id) => this.colorFor(id)),
				notes,
				"",
				this
			);
			this.bindDbRefs(notes);
		}

		// Occurrences: the entity's emergent chronology.
		await this.renderOccurrences(root, e);
	}

	private colorFor(id: string): string | null {
		// Only this entity's own markers are likely; resolve lazily is fine.
		return id === this.entityId
			? this.typeColor(this.entity?.type ?? "")
			: "";
	}

	private bindDbRefs(host: HTMLElement): void {
		host.querySelectorAll<HTMLElement>(".hl-db-ref").forEach((el) => {
			const id = el.getAttr("data-db-id");
			if (id)
				el.addEventListener("click", () =>
					void this.plugin.openEntityView(id)
				);
		});
	}

	private async renderOccurrences(
		root: HTMLElement,
		e: EntityEntry
	): Promise<void> {
		const events = await this.plugin.store.readEvents();
		const hits: { evId: string; tag: string; snippet: string; key: number }[] =
			[];
		for (const [evId, ev] of events) {
			if (!parseDbMarks(ev.summary).some((m) => m.id === e.id)) continue;
			const key = ev.tag ? parseYearTag(ev.tag)?.sortKey ?? 0 : 0;
			const snippet = stripDbMarkers(ev.summary)
				.replace(/\*\*([^*\n]+)\*\*/g, "$1")
				.replace(/~~([^~\n]+)~~/g, "$1")
				.replace(/`([^`\n]+)`/g, "$1")
				.replace(/^#{1,6}\s+/gm, "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 160);
			hits.push({ evId, tag: ev.tag ?? "", snippet, key });
		}
		hits.sort((a, b) => a.key - b.key);
		root.createDiv({
			cls: "hl-overline",
			text: `Occurrences · ${hits.length}`,
		});
		const list = root.createDiv({ cls: "hl-page-occurrences" });
		if (!hits.length) {
			list.createDiv({
				cls: "hl-entity-occ-empty",
				text: "Not annotated in any event summary yet.",
			});
			return;
		}
		for (const hit of hits) {
			const row = list.createDiv({ cls: "hl-entity-occ" });
			const decoded = hit.tag ? parseYearTag(hit.tag) : null;
			row.createSpan({
				cls: "hl-page-occ-year",
				text: decoded ? describeYear(decoded) : hit.tag,
			});
			row.createSpan({ cls: "hl-entity-occ-snippet", text: hit.snippet });
			const reveal = row.createEl("button", { cls: "hl-icon-btn hl-occ-reveal" });
			setIcon(reveal, "gantt-chart");
			reveal.setAttr("aria-label", "在时间线上显示");
			reveal.addEventListener("click", (ev) => {
				ev.stopPropagation();
				void this.plugin.revealOnTimeline(hit.evId, hit.tag);
			});
			row.addEventListener("click", () =>
				this.plugin.openSummary(hit.evId, hit.tag, () =>
					void this.refresh()
				)
			);
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
}
