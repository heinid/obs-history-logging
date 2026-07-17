// maps.md — historical map entries. Each entry ties one vault image to the
// history data: a title, an optional time range (year tag text), and the
// events / entities it illustrates. Format mirrors entities.md:
//
//   ## m3k7f9a2
//   title: 伯罗奔尼撒战争形势图
//   image: maps/peloponnesian-war.png
//   range: #bc/04/3/1
//   events: k7f3a9x1, p2d8c4n5
//   entities: a1b2c3d4
//   updated: 2026-07-17
//
//   自由注记（markdown）

export const MAPS_HEADER = "# History Logging — maps";

export interface MapEntry {
	id: string;
	title: string;
	// Vault path / link target of the image (no `![[ ]]` wrapper, no size).
	image: string;
	// Free-form time range: a year tag, or "tagA–tagB", or empty.
	range: string;
	// Linked event ids (events.md) and entity ids (entities.md).
	events: string[];
	entities: string[];
	updated?: string;
	// Free markdown annotation.
	body: string;
}

const listOf = (val: string): string[] =>
	val
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

export function parseMapsFile(content: string): Map<string, MapEntry> {
	const normalised = content.replace(/\r\n/g, "\n");
	const heading = /^##\s+([0-9a-z]{8})\s*$/gm;
	const heads: { id: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = heading.exec(normalised)) !== null)
		heads.push({
			id: m[1],
			start: m.index,
			bodyStart: m.index + m[0].length,
		});
	const maps = new Map<string, MapEntry>();
	for (let i = 0; i < heads.length; i++) {
		const head = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		maps.set(
			head.id,
			parseMapBlock(head.id, normalised.slice(head.bodyStart, end))
		);
	}
	return maps;
}

function parseMapBlock(id: string, block: string): MapEntry {
	const lines = block.replace(/^\n+/, "").split("\n");
	const entry: MapEntry = {
		id,
		title: "",
		image: "",
		range: "",
		events: [],
		entities: [],
		body: "",
	};
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const field = /^(title|image|range|events|entities|updated):\s*(.*)$/.exec(
			line
		);
		if (!field) {
			if (!line.trim()) continue;
			break;
		}
		const val = field[2].trim();
		switch (field[1]) {
			case "title":
				entry.title = val;
				break;
			case "image":
				entry.image = val;
				break;
			case "range":
				entry.range = val;
				break;
			case "events":
				entry.events = listOf(val);
				break;
			case "entities":
				entry.entities = listOf(val);
				break;
			case "updated":
				entry.updated = val;
				break;
		}
	}
	entry.body = lines.slice(i).join("\n").trim();
	return entry;
}

export function serializeMapsFile(entries: Map<string, MapEntry>): string {
	const parts: string[] = [MAPS_HEADER, ""];
	const ids = Array.from(entries.keys()).sort();
	for (const id of ids) {
		const e = entries.get(id);
		if (!e) continue;
		parts.push(`## ${id}`);
		if (e.title) parts.push(`title: ${e.title}`);
		if (e.image) parts.push(`image: ${e.image}`);
		if (e.range) parts.push(`range: ${e.range}`);
		if (e.events.length) parts.push(`events: ${e.events.join(", ")}`);
		if (e.entities.length)
			parts.push(`entities: ${e.entities.join(", ")}`);
		if (e.updated) parts.push(`updated: ${e.updated}`);
		parts.push("");
		if (e.body.trim()) {
			parts.push(e.body.trim());
			parts.push("");
		}
	}
	return parts.join("\n");
}
