// Pure (Obsidian-free) parse / serialize for the `events.md` data file.
//
// Format — one entry per `##` heading, hand-editable:
//
//   # History Logging — events
//
//   ## k7f3a9x1
//   tag: #ad/07/1/0
//   source: [[古典日语语法]]
//   updated: 2026-07-07
//
//   奈良时代定都平城京，律令制与遣唐使高峰……
//   (summary body continues until the next `## ` heading or EOF)

import { EventEntry } from "./types";

export const EVENTS_HEADER = "# History Logging — events";

const META_KEYS = new Set(["tag", "source", "updated"]);

export function parseEventsFile(content: string): Map<string, EventEntry> {
	const map = new Map<string, EventEntry>();
	const normalised = content.replace(/\r\n/g, "\n");
	// Split on level-2 headings that name an id.
	const re = /^##\s+([0-9a-z]{8})\s*$/gm;
	const heads: { id: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null) {
		heads.push({
			id: m[1],
			start: m.index,
			bodyStart: m.index + m[0].length,
		});
	}
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const block = normalised.slice(h.bodyStart, end);
		map.set(h.id, parseEntryBlock(h.id, block));
	}
	return map;
}

function parseEntryBlock(id: string, block: string): EventEntry {
	const lines = block.replace(/^\n+/, "").split("\n");
	const entry: EventEntry = { id, summary: "" };
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			break;
		}
		const kv = /^(\w+):\s*(.*)$/.exec(line);
		if (kv && META_KEYS.has(kv[1])) {
			const key = kv[1] as "tag" | "source" | "updated";
			const val = kv[2].trim();
			if (val) entry[key] = val;
		} else {
			// Non-metadata line before a blank => body starts here.
			break;
		}
	}
	entry.summary = lines.slice(i).join("\n").replace(/\s+$/, "");
	return entry;
}

export function serializeEventsFile(entries: Map<string, EventEntry>): string {
	const parts: string[] = [EVENTS_HEADER, ""];
	// Stable order by id for clean diffs.
	const ids = Array.from(entries.keys()).sort();
	for (const id of ids) {
		const e = entries.get(id);
		if (!e) continue;
		parts.push(`## ${id}`);
		if (e.tag) parts.push(`tag: ${e.tag}`);
		if (e.source) parts.push(`source: ${e.source}`);
		if (e.updated) parts.push(`updated: ${e.updated}`);
		parts.push("");
		parts.push(e.summary.trim());
		parts.push("");
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}
