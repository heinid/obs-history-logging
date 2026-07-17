// Discover map-image candidates for an event: images embedded in the same
// note block as the event's `{ev …}` marker (author placed them together),
// plus images embedded in the event's summary text.

import { App, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { blockAt, evLocationIndex } from "./scan";
import { MapEntry } from "./maps-format";
import { imageEmbeds } from "./map-text";
import { stripEvMarkers } from "./parser";
import { stripDbMarkers } from "./db-marker";
import { yearTagRegex } from "./year-tag";

export { imageEmbeds };

// The note paragraph containing the `{ev <id> …}` marker, or null when the
// marker cannot be located in the vault.
export async function evSourceBlock(
	app: App,
	id: string
): Promise<string | null> {
	const needle = `{ev ${id} `;
	const known = evLocationIndex.get(id);
	const candidates: TFile[] = [];
	if (known) {
		const f = app.vault.getAbstractFileByPath(known);
		if (f instanceof TFile) candidates.push(f);
	}
	for (const file of candidates.length
		? candidates
		: app.vault.getMarkdownFiles()) {
		const content = (await app.vault.cachedRead(file)).replace(
			/\r\n/g,
			"\n"
		);
		const idx = content.indexOf(needle);
		if (idx === -1) continue;
		evLocationIndex.set(id, file.path);
		return blockAt(content, idx).text;
	}
	// Cached location was stale — fall back to a full scan once.
	if (candidates.length) {
		evLocationIndex.delete(id);
		return evSourceBlock(app, id);
	}
	return null;
}

// One-line context for an event: the first line of its summary, or —
// lacking one — the text of the note block around its `{ev …}` marker.
export interface EventPreview {
	text: string;
	// True when the text came from the note source rather than the summary.
	fromSource: boolean;
}

export async function eventPreview(
	plugin: HistoryLoggingPlugin,
	id: string
): Promise<EventPreview> {
	const summary = ((await plugin.store.getEvent(id))?.summary ?? "").trim();
	if (summary) {
		const line =
			stripDbMarkers(summary)
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.length > 0) ?? "";
		return { text: line, fromSource: false };
	}
	const block = await evSourceBlock(plugin.app, id);
	if (!block) return { text: "", fromSource: false };
	const text = stripDbMarkers(stripEvMarkers(block))
		.replace(yearTagRegex(), "")
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return { text, fromSource: true };
}

export interface MapCandidate {
	// Link target of the image (as written in the embed).
	link: string;
	// Existing map entry for this image, if already linked.
	map?: MapEntry;
}

// Candidate images for an event, note-block images first, then summary
// images, each marked with its existing map entry (matched by resolved file).
export async function mapCandidatesForEvent(
	plugin: HistoryLoggingPlugin,
	id: string,
	summary?: string
): Promise<MapCandidate[]> {
	const app = plugin.app;
	const links: string[] = [];
	const block = await evSourceBlock(app, id);
	if (block) links.push(...imageEmbeds(block));
	const text =
		summary ?? (await plugin.store.getEvent(id))?.summary ?? "";
	for (const l of imageEmbeds(text)) if (!links.includes(l)) links.push(l);
	if (!links.length) return [];
	const maps = await plugin.store.readMaps();
	const resolve = (link: string): string =>
		app.metadataCache.getFirstLinkpathDest(link, "")?.path ?? link;
	const byPath = new Map<string, MapEntry>();
	for (const m of maps.values()) byPath.set(resolve(m.image), m);
	return links.map((link) => ({ link, map: byPath.get(resolve(link)) }));
}
