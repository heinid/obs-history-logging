import {
	Component,
	MarkdownRenderer,
	Notice,
	TFile,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName } from "./db-format";
import { dbMarkersToHtml, parseDbMarks, stripDbMarkers } from "./db-marker";
import { EntityModal } from "./entity-modal";
import { openDbEntityEditor } from "./quiz-render";
import { describeYear, parseYearTag } from "./year-tag";

// Shared renderer for one entity's full page: hero (headword + type pill +
// id), per-language cards, free notes and the emergent chronology. Used by
// both the standalone tab (EntityView) and the admin backstage, which embeds
// it in its own navigation stack.
export interface EntityPageCtx {
	plugin: HistoryLoggingPlugin;
	component: Component;
	// Re-render after an edit changed the entity.
	refresh: () => void;
}

export async function renderEntityPage(
	root: HTMLElement,
	entityId: string,
	ctx: EntityPageCtx
): Promise<void> {
	const { plugin } = ctx;
	const entity =
		(await plugin.store.readEntities()).get(entityId) ?? null;
	const types = await plugin.store.readDbTypes();
	root.empty();
	root.addClass("hl-entity-page");
	if (!entity) {
		root.createDiv({
			cls: "hl-entity-occ-empty",
			text: `No entity with id ${entityId} in entities.md`,
		});
		return;
	}
	const typeColor = (name: string): string | null =>
		types.find((t) => t.name === name)?.color ?? null;

	// Hero.
	const hero = root.createDiv({ cls: "hl-page-hero" });
	const heroTop = hero.createDiv({ cls: "hl-page-hero-top" });
	heroTop.createSpan({ cls: "hl-page-headword", text: displayName(entity) });
	const pill = heroTop.createSpan({
		cls: "hl-type-pill hl-type-pill-static",
		text: entity.type || "?",
	});
	const color = typeColor(entity.type);
	if (color) {
		pill.style.color = color;
		pill.style.borderColor = color;
	}
	heroTop.createSpan({ cls: "hl-page-id", text: entity.id });
	const edit = heroTop.createEl("button", {
		cls: "hl-modal-foot-btn hl-page-edit",
		text: "编辑",
	});
	edit.addEventListener("click", () => {
		new EntityModal(plugin.app, plugin, entity, false, () =>
			ctx.refresh()
		).open();
	});
	if (entity.tags.length) {
		const tags = hero.createDiv({ cls: "hl-page-tags" });
		for (const t of entity.tags)
			tags.createSpan({ cls: "hl-tag-chip", text: t });
	}

	// Languages.
	const langs: string[] = [];
	for (const l of [
		...entity.labels.map((x) => x.lang),
		...entity.readings.map((x) => x.lang),
		...entity.audios.map((x) => x.lang),
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
			const words = entity.labels
				.filter((x) => x.lang === lang)
				.map((x) => x.text);
			if (words.length)
				card.createDiv({
					cls: "hl-page-lang-word",
					text: words.join(" · "),
				});
			const readings = entity.readings
				.filter((x) => x.lang === lang)
				.map((x) => x.text);
			if (readings.length)
				card.createDiv({
					cls: "hl-page-lang-reading",
					text: readings.join(" · "),
				});
			for (const a of entity.audios.filter((x) => x.lang === lang)) {
				const play = card.createEl("button", {
					cls: "hl-play-btn",
					text: "▶",
				});
				play.setAttr("aria-label", a.link);
				play.addEventListener("click", () => playAudio(plugin, a.link));
			}
		}
	}

	// Notes.
	if (entity.body.trim()) {
		root.createDiv({ cls: "hl-overline", text: "Notes" });
		const notes = root.createDiv({ cls: "hl-page-notes" });
		await MarkdownRenderer.render(
			plugin.app,
			dbMarkersToHtml(entity.body, (id) =>
				id === entityId ? typeColor(entity.type) : ""
			),
			notes,
			"",
			ctx.component
		);
		notes.querySelectorAll<HTMLElement>(".hl-db-ref").forEach((el) => {
			const id = el.getAttr("data-db-id");
			if (id)
				el.addEventListener("click", () =>
					openDbEntityEditor(plugin, id, ctx.refresh)
				);
		});
	}

	await renderOccurrences(root, entity, ctx);
}

async function renderOccurrences(
	root: HTMLElement,
	e: EntityEntry,
	ctx: EntityPageCtx
): Promise<void> {
	const { plugin } = ctx;
	const events = await plugin.store.readEvents();
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
		const reveal = row.createEl("button", {
			cls: "hl-icon-btn hl-occ-reveal",
		});
		setIcon(reveal, "gantt-chart");
		reveal.setAttr("aria-label", "在时间线上显示");
		reveal.addEventListener("click", (ev) => {
			ev.stopPropagation();
			void plugin.revealOnTimeline(hit.evId, hit.tag);
		});
		row.addEventListener("click", () =>
			plugin.openSummary(hit.evId, hit.tag, () => ctx.refresh())
		);
	}
}

function playAudio(plugin: HistoryLoggingPlugin, link: string): void {
	const path = link.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
	const file = plugin.app.metadataCache.getFirstLinkpathDest(path, "");
	if (!(file instanceof TFile)) {
		new Notice(`Audio attachment not found: ${link}`);
		return;
	}
	void new Audio(plugin.app.vault.getResourcePath(file)).play();
}

// Entities per type, for the type manager's usage badges.
export function typeUsage(
	entities: Iterable<EntityEntry>,
	types: DbType[]
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const t of types) counts.set(t.name, 0);
	for (const e of entities)
		counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
	return counts;
}
