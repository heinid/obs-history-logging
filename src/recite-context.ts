// Context hints for entity recitation: an occurrence line of the entity
// pulled from enabled-tag notes / event summaries, with every known spelling
// of the entity masked out so the hint never spoils the answer.

import type HistoryLoggingPlugin from "./main";
import { EntityEntry } from "./db-format";
import { dbEnabledFor } from "./vault-db";
import { maskLabels, scanNoteOccurrences } from "./db-occurrences";

export interface ContextHint {
	source: string; // file basename
	text: string; // masked line snippet
}

// All occurrence lines of one entity inside enabled-tag notes, masked.
// Scanned on demand (first hint request per card) and cached per session.
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
			out.push({ source: file.basename, text });
		}
	}
	return out;
}
