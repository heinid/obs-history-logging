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
	text: string; // masked (blanks) — safe to print
	raw: string; // unmasked snippet, for interactive in-place masking
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
				raw: occ.snippet,
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
			raw: snippet,
			evId,
			tag: ev.tag ?? "",
		});
	}
	return out;
}

// Batched variant for the lexicon list: one pass over the vault collects
// occurrence lines for many entities at once.
export async function contextHintsForMany(
	plugin: HistoryLoggingPlugin,
	entities: EntityEntry[]
): Promise<Map<string, ContextHint[]>> {
	const out = new Map<string, ContextHint[]>();
	const labelsOf = new Map(
		entities.map((e) => [e.id, e.labels.map((l) => l.text)])
	);
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
			const labels = labelsOf.get(e.id) ?? [];
			for (const occ of scanNoteOccurrences(content, e.id)
				.occurrences) {
				const text = maskLabels(occ.snippet, labels);
				if (text.replace(/____/g, "").trim().length < 4) continue;
				push(e.id, {
					kind: "note",
					source: file.basename,
					text,
					raw: occ.snippet,
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
		for (const e of entities) {
			if (!marks.some((m) => m.id === e.id)) continue;
			const labels = labelsOf.get(e.id) ?? [];
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
			push(e.id, {
				kind: "event",
				source: ev.tag ? `事件 ${ev.tag}` : "事件",
				text,
				raw: snippet,
				evId,
				tag: ev.tag ?? "",
			});
		}
	}
	return out;
}

// Split a snippet into plain text and hidden (label-match) segments, so the
// UI can render the matches as in-place interactive masks instead of blanks.
export function maskedSegments(
	snippet: string,
	labels: string[]
): Array<string | { hidden: string }> {
	const cleaned = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
	if (!cleaned.length) return [snippet];
	cleaned.sort((a, b) => b.length - a.length);
	const pattern = cleaned
		.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	const re = new RegExp(pattern, "gi");
	const out: Array<string | { hidden: string }> = [];
	let last = 0;
	for (const m of snippet.matchAll(re)) {
		const at = m.index ?? 0;
		if (at > last) out.push(snippet.slice(last, at));
		out.push({ hidden: m[0] });
		last = at + m[0].length;
	}
	if (last < snippet.length) out.push(snippet.slice(last));
	return out;
}
