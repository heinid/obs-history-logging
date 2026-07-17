// Context hints for entity recitation: an occurrence line of the entity
// pulled from enabled-tag notes / event summaries, with every known spelling
// of the entity masked out so the hint never spoils the answer. Each hint
// carries its origin so the player can jump there (note position or the
// event's timeline card).

import type HistoryLoggingPlugin from "./main";
import { EntityEntry } from "./db-format";
import { dbEnabledFor } from "./vault-db";
import { maskLabels, scanNoteOccurrences } from "./db-occurrences";
import { parseDbMarks, stripDbMarkers } from "./db-marker";

export type ContextHint = {
	source: string;
	text: string;
} & (
	| { kind: "note"; path: string; offset: number; length: number }
	| { kind: "event"; evId: string; tag: string }
);

// All occurrence lines of one entity, masked: enabled-tag notes plus event
// summaries. Scanned on demand (first hint request per card) and cached per
// session.
export async function contextHintsFor(
	plugin: HistoryLoggingPlugin,
	entity: EntityEntry
): Promise<ContextHint[]> {
	const labels = entity.labels.map((l) => l.text);
	const out: ContextHint[] = [];
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (!dbEnabledFor(plugin, file.path)) continue;
		const content = await plugin.app.vault.cachedRead(file);
		if (!content.includes(entity.id)) continue;
		const hits = scanNoteOccurrences(content, entity.id);
		for (const occ of hits.occurrences) {
			const text = maskLabels(occ.snippet, labels);
			if (text.replace(/____/g, "").trim().length < 4) continue;
			out.push({
				kind: "note",
				source: file.basename,
				text,
				path: file.path,
				offset: occ.offset,
				length: occ.length,
			});
		}
	}
	const events = await plugin.store.readEvents();
	for (const [evId, ev] of events) {
		if (!parseDbMarks(ev.summary).some((m) => m.id === entity.id))
			continue;
		const snippet = stripDbMarkers(ev.summary)
			.replace(/\*\*([^*\n]+)\*\*/g, "$1")
			.replace(/~~([^~\n]+)~~/g, "$1")
			.replace(/`([^`\n]+)`/g, "$1")
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 160);
		const text = maskLabels(snippet, labels);
		if (text.replace(/____/g, "").trim().length < 4) continue;
		out.push({
			kind: "event",
			source: ev.tag ? `事件 ${ev.tag}` : "事件",
			text,
			evId,
			tag: ev.tag ?? "",
		});
	}
	return out;
}
