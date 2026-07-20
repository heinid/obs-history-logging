// Context lines for lexicon entries: occurrence lines of an entity pulled
// from enabled-tag notes / event summaries, kept as raw markdown (with the
// `{db …}` markers intact) so the UI renders them through the same pipeline
// as notes and summaries — entity references become the standard masked,
// clickable spans. Each hint carries its origin so the list can jump there.

import { MarkdownRenderer } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EntityEntry } from "./db-format";
import { dbEnabledFor } from "./vault-db";
import { scanNoteOccurrences } from "./db-occurrences";
import { dbMarkersToHtml, parseDbMarks } from "./db-marker";
import { DbColors, wireDbRef } from "./quiz-render";

export type ContextHint = {
	source: string;
	// Markdown of the occurrence line, `{db …}` markers preserved.
	raw: string;
} & (
	| { kind: "note"; path: string; offset: number; length: number }
	| { kind: "event"; evId: string; tag: string }
);

// One pass over the vault collects occurrence lines for many entities at
// once (the lexicon list needs hints for every visible entry).
export async function contextHintsForMany(
	plugin: HistoryLoggingPlugin,
	entities: EntityEntry[]
): Promise<Map<string, ContextHint[]>> {
	const out = new Map<string, ContextHint[]>();
	const push = (id: string, hint: ContextHint): void => {
		const list = out.get(id) ?? [];
		list.push(hint);
		out.set(id, list);
	};
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (!dbEnabledFor(plugin, file.path)) continue;
		const content = await plugin.app.vault.cachedRead(file);
		for (const e of entities) {
			if (!content.includes(e.id)) continue;
			for (const occ of scanNoteOccurrences(content, e.id)
				.occurrences) {
				if (!occ.raw.trim()) continue;
				push(e.id, {
					kind: "note",
					source: file.basename,
					raw: occ.raw,
					path: file.path,
					offset: occ.offset,
					length: occ.length,
				});
			}
		}
	}
	const events = await plugin.store.readEvents();
	for (const [evId, ev] of events) {
		const marks = parseDbMarks(ev.summary);
		if (!marks.length) continue;
		const raw = ev.summary.replace(/\s+/g, " ").trim();
		if (!raw) continue;
		for (const e of entities) {
			if (!marks.some((m) => m.id === e.id)) continue;
			push(e.id, {
				kind: "event",
				source: ev.tag ? `事件 ${ev.tag}` : "事件",
				raw,
				evId,
				tag: ev.tag ?? "",
			});
		}
	}
	return out;
}

// Render an occurrence line through the same pipeline as notes/summaries:
// full markdown, `{db …}` markers folded into the standard entity spans
// with the standard behaviours. The focus entity is always masked (it is
// the answer); other references follow the global immersive-recall toggle.
export function renderContextMarkdown(
	plugin: HistoryLoggingPlugin,
	raw: string,
	focusId: string,
	host: HTMLElement,
	colors: DbColors,
	sourcePath = ""
): void {
	void MarkdownRenderer.render(
		plugin.app,
		dbMarkersToHtml(raw, (id) => colors.get(id) ?? null),
		host,
		sourcePath,
		plugin
	).then(() => {
		for (const el of Array.from(
			host.querySelectorAll<HTMLElement>("span.hl-db-ref")
		)) {
			const id = el.getAttr("data-db-id");
			if (!id) continue;
			wireDbRef(plugin, el, id, {
				mask: id === focusId || plugin.settings.dbMaskMode,
			});
		}
	});
}
