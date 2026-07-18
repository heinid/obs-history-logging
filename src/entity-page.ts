import {
	Component,
	MarkdownRenderer,
	Notice,
	TFile,
	setIcon,
} from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { DbType, EntityEntry, displayName, orderLangs } from "./db-format";
import { dbMarkersToHtml, parseDbMarks, stripDbMarkers } from "./db-marker";
import { EntityModal } from "./entity-modal";
import { openDbEntityEditor } from "./quiz-render";
import { describeYear, parseYearTag } from "./year-tag";
import { NoteOccurrences, scanNoteOccurrences } from "./db-occurrences";
import { dbEnabledFor } from "./vault-db";
import { jumpToLocation } from "./jump";
import { enableContainerImageResize } from "./image-resize";

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
	const ordered = orderLangs(langs);
	if (ordered.length) {
		root.createDiv({ cls: "hl-overline", text: "Languages" });
		const grid = root.createDiv({ cls: "hl-page-lang-grid" });
		for (const lang of ordered) {
			const card = grid.createDiv({ cls: "hl-lang-card" });
			const head = card.createDiv({ cls: "hl-lang-card-head" });
			head.createSpan({
				cls: "hl-lang-badge",
				text: lang.toUpperCase(),
			});
			// Primary spelling on its own line; further same-language
			// spellings go below in faint text — a separator inside the
			// headline would collide with middle dots inside names.
			const words = entity.labels
				.filter((x) => x.lang === lang)
				.map((x) => x.text);
			const readings = entity.readings
				.filter((x) => x.lang === lang)
				.map((x) => x.text);
			if (words.length) {
				const line = card.createDiv({ cls: "hl-page-lang-word" });
				line.createSpan({ text: words[0] });
				// Reading trails the primary spelling in parentheses, in a
				// style distinct from both the name and the aliases below.
				if (readings.length)
					line.createSpan({
						cls: "hl-page-lang-reading",
						text: `（${readings.join("／")}）`,
					});
			}
			if (words.length > 1)
				card.createDiv({
					cls: "hl-page-lang-aliases",
					text: words.slice(1).join("／"),
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
		enableContainerImageResize(
			notes,
			() => entity.body,
			(text) => {
				entity.body = text;
				void plugin.store.upsertEntity(entity);
			}
		);
	}

	await renderOccurrences(root, entity, ctx);
	await renderNoteOccurrences(root, entity, ctx);
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
		text: `事件摘要中的出现 · ${hits.length}`,
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

interface FileHits extends NoteOccurrences {
	path: string;
	name: string;
}

// Occurrences inside enabled-tag notes. The timestamp belongs to the
// entity × file pair (only the first annotation in a file gets the fn wrap
// that keys the `[fnid.date]:` metadata), so it shows on the file heading,
// never on individual occurrence rows.
let notesOccFlat = false;

async function scanEnabledNotes(
	plugin: HistoryLoggingPlugin,
	entityId: string
): Promise<FileHits[]> {
	const out: FileHits[] = [];
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (!dbEnabledFor(plugin, file.path)) continue;
		const content = await plugin.app.vault.cachedRead(file);
		if (!content.includes(entityId)) continue;
		const hits = scanNoteOccurrences(content, entityId);
		if (!hits.occurrences.length) continue;
		out.push({ path: file.path, name: file.basename, ...hits });
	}
	// Freshest first-annotated files first; undated ones after, by name.
	out.sort((a, b) => {
		if (a.firstAnnotated && b.firstAnnotated)
			return b.firstAnnotated.localeCompare(a.firstAnnotated);
		if (a.firstAnnotated) return -1;
		if (b.firstAnnotated) return 1;
		return a.name.localeCompare(b.name);
	});
	return out;
}

function firstAnnotatedLabel(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return `首次标注 ${d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	})}`;
}

async function renderNoteOccurrences(
	root: HTMLElement,
	e: EntityEntry,
	ctx: EntityPageCtx
): Promise<void> {
	const { plugin } = ctx;
	const files = await scanEnabledNotes(plugin, e.id);
	const total = files.reduce((n, f) => n + f.occurrences.length, 0);
	const head = root.createDiv({ cls: "hl-overline hl-notes-occ-head" });
	head.createSpan({ text: `笔记中的出现 · ${total}` });
	if (files.length) {
		const toggle = head.createEl("button", {
			cls: "hl-icon-btn hl-notes-occ-toggle",
		});
		const paintIcon = (): void =>
			setIcon(toggle, notesOccFlat ? "list" : "folder");
		paintIcon();
		toggle.setAttr("aria-label", "切换 按文件分组 / 平铺");
		toggle.addEventListener("click", () => {
			notesOccFlat = !notesOccFlat;
			paintIcon();
			paintList();
		});
	}
	const list = root.createDiv({ cls: "hl-page-occurrences" });
	const row = (
		parent: HTMLElement,
		file: FileHits,
		hit: FileHits["occurrences"][number],
		withFile: boolean
	): void => {
		const el = parent.createDiv({ cls: "hl-entity-occ" });
		if (withFile)
			el.createSpan({ cls: "hl-page-occ-year", text: file.name });
		el.createSpan({ cls: "hl-entity-occ-snippet", text: hit.snippet });
		if (hit.fnId) {
			const badge = el.createSpan({
				cls: "hl-occ-fn-badge",
				text: "fn",
			});
			badge.setAttr(
				"aria-label",
				"首次标注处 — 时间元数据来自这里"
			);
		}
		el.addEventListener("click", () =>
			void jumpToLocation(
				plugin.app,
				file.path,
				hit.offset,
				hit.length
			)
		);
	};
	const paintList = (): void => {
		list.empty();
		if (!files.length) {
			list.createDiv({
				cls: "hl-entity-occ-empty",
				text: "启用词条功能的笔记中还没有出现。",
			});
			return;
		}
		if (notesOccFlat) {
			for (const file of files)
				for (const hit of file.occurrences) row(list, file, hit, true);
			return;
		}
		for (const file of files) {
			const group = list.createDiv({ cls: "hl-occ-file-group" });
			const gh = group.createDiv({ cls: "hl-occ-file-head" });
			gh.createSpan({ cls: "hl-occ-file-name", text: file.name });
			gh.createSpan({
				cls: "hl-occ-file-meta",
				text: `${file.occurrences.length} 处${
					file.firstAnnotated
						? ` · ${firstAnnotatedLabel(file.firstAnnotated)}`
						: ""
				}`,
			});
			for (const hit of file.occurrences) row(group, file, hit, false);
		}
	};
	paintList();
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
