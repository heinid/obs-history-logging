import { App, getAllTags } from "obsidian";
import { TimelineEntry } from "./scan";
import { QueryContext, matchesQuery, parseQuery } from "./query";

// The set of event ids whose year-tag occurrences match a profile query,
// reusing the same text + file:#tag / path: matching the timeline uses. Shared
// by the timeline "practice this layout" action and the recitation deck wall.
export function eventIdsForQuery(
	app: App,
	entries: TimelineEntry[],
	query: string
): Set<string> {
	const pq = parseQuery(query);
	const fileTags = new Map<string, readonly string[]>();
	const contextFor = (entry: TimelineEntry): QueryContext => {
		let tags = fileTags.get(entry.filePath);
		if (!tags) {
			const file = app.vault.getFileByPath(entry.filePath);
			const cache = file ? app.metadataCache.getFileCache(file) : null;
			tags = getAllTags(cache ?? {}) ?? [];
			fileTags.set(entry.filePath, tags);
		}
		return { fileTags: tags, filePath: entry.filePath };
	};
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry.evId) continue;
		const hay = `${entry.tag} ${entry.snippet} ${
			entry.summary ?? ""
		}`.toLowerCase();
		if (matchesQuery(hay, pq, contextFor(entry))) ids.add(entry.evId);
	}
	return ids;
}
