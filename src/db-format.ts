// Pure (Obsidian-free) parse / serialize for the entity database files:
// `entities.md` (the entries) and `db-types.md` (the user-editable list of
// entity types). Both are hand-editable markdown, like events.md.
//
// entities.md — one entry per `##` heading:
//
//   # History Logging — entities
//
//   ## q3x8k2p1
//   type: polity
//   label: zh 希腊
//   label: en Greece
//   label: ja ギリシャ
//   reading: ja girisha
//   audio: ja [[greece.mp3]]
//   tags: 欧洲史, 政权
//   updated: 2026-07-09
//
//   自由正文（markdown）
//
// db-types.md — one type per list line: `- <name> | <color>`

export interface EntityLabel {
	lang: string;
	text: string;
}

export interface EntityReading {
	lang: string;
	text: string;
}

export interface EntityAudio {
	lang: string;
	// A vault attachment link, e.g. `[[greece.mp3]]`.
	link: string;
}

export interface EntityEntry {
	id: string;
	type: string;
	// The first label is the entry's display name; the rest are aliases /
	// other-language spellings. All of them feed recognition and completion.
	labels: EntityLabel[];
	readings: EntityReading[];
	audios: EntityAudio[];
	tags: string[];
	updated?: string;
	body: string;
}

export interface DbType {
	name: string;
	color: string;
}

export const ENTITIES_HEADER = "# History Logging — entities";
export const DB_TYPES_HEADER = "# History Logging — entity types";

// Seed types: broad enough that annotating "希腊灭亡" never stalls on
// classification. Users add / rename / recolor freely.
export const DEFAULT_DB_TYPES: DbType[] = [
	{ name: "person", color: "#e0685c" },
	{ name: "polity", color: "#d69a3c" },
	{ name: "place", color: "#4faa5e" },
	{ name: "event", color: "#c95693" },
	{ name: "concept", color: "#5c7fe0" },
	{ name: "people", color: "#8a63c9" },
	{ name: "work", color: "#3aa8a0" },
	{ name: "artifact", color: "#a88b4a" },
	{ name: "title", color: "#647687" },
	{ name: "era", color: "#b0568a" },
];

export function displayName(e: EntityEntry): string {
	return e.labels[0]?.text ?? e.id;
}

export function parseEntitiesFile(content: string): Map<string, EntityEntry> {
	const map = new Map<string, EntityEntry>();
	const normalised = content.replace(/\r\n/g, "\n");
	const re = /^##\s+([0-9a-z]{8})\s*$/gm;
	const heads: { id: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null)
		heads.push({ id: m[1], start: m.index, bodyStart: m.index + m[0].length });
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		map.set(h.id, parseEntityBlock(h.id, normalised.slice(h.bodyStart, end)));
	}
	return map;
}

function parseEntityBlock(id: string, block: string): EntityEntry {
	const lines = block.replace(/^\n+/, "").split("\n");
	const entry: EntityEntry = {
		id,
		type: "",
		labels: [],
		readings: [],
		audios: [],
		tags: [],
		body: "",
	};
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			break;
		}
		const kv = /^(\w+):\s*(.*)$/.exec(line);
		if (!kv) break;
		const val = kv[2].trim();
		switch (kv[1]) {
			case "type":
				entry.type = val;
				break;
			case "label": {
				const lm = /^(\S+)\s+(.+)$/.exec(val);
				if (lm) entry.labels.push({ lang: lm[1], text: lm[2].trim() });
				break;
			}
			case "reading": {
				const rm = /^(\S+)\s+(.+)$/.exec(val);
				if (rm) entry.readings.push({ lang: rm[1], text: rm[2].trim() });
				break;
			}
			case "audio": {
				const am = /^(\S+)\s+(.+)$/.exec(val);
				if (am) entry.audios.push({ lang: am[1], link: am[2].trim() });
				break;
			}
			case "tags":
				entry.tags = val
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t.length > 0);
				break;
			case "updated":
				if (val) entry.updated = val;
				break;
			default:
				// Unknown key: soft-constraint philosophy — keep scanning.
				break;
		}
	}
	entry.body = lines.slice(i).join("\n").replace(/\s+$/, "");
	return entry;
}

export function serializeEntitiesFile(
	entries: Map<string, EntityEntry>
): string {
	const parts: string[] = [ENTITIES_HEADER, ""];
	const ids = Array.from(entries.keys()).sort();
	for (const id of ids) {
		const e = entries.get(id);
		if (!e) continue;
		parts.push(`## ${id}`);
		if (e.type) parts.push(`type: ${e.type}`);
		for (const l of e.labels) parts.push(`label: ${l.lang} ${l.text}`);
		for (const r of e.readings) parts.push(`reading: ${r.lang} ${r.text}`);
		for (const a of e.audios) parts.push(`audio: ${a.lang} ${a.link}`);
		if (e.tags.length) parts.push(`tags: ${e.tags.join(", ")}`);
		if (e.updated) parts.push(`updated: ${e.updated}`);
		parts.push("");
		if (e.body.trim()) {
			parts.push(e.body.trim());
			parts.push("");
		}
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}

export function parseDbTypesFile(content: string): DbType[] {
	const out: DbType[] = [];
	for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
		const m = /^-\s+([^|]+?)\s*\|\s*(#[0-9a-fA-F]{3,8})\s*$/.exec(line);
		if (m) out.push({ name: m[1].trim(), color: m[2] });
	}
	return out;
}

export function serializeDbTypesFile(types: DbType[]): string {
	const parts = [DB_TYPES_HEADER, ""];
	for (const t of types) parts.push(`- ${t.name} | ${t.color}`);
	return parts.join("\n") + "\n";
}
