// maps.md — historical map entries. Each entry ties one vault image to the
// history data: a title and the events / entities it illustrates (its place
// in time is derived from the linked events). Format mirrors entities.md:
//
//   ## m3k7f9a2
//   title: 伯罗奔尼撒战争形势图
//   image: maps/peloponnesian-war.png
//   tags: 希腊史, 战役图
//   events: k7f3a9x1, p2d8c4n5
//   entities: a1b2c3d4
//   updated: 2026-07-17
//
//   自由注记（markdown）
//
//   ### occlusions
//   - o3f8k2c1 | 0.4200,0.3100,0.1200,0.0800
//     q: 拜占庭首都是哪座城？
//     hint: 博斯普鲁斯海峡边
//     君士坦丁堡，{db a1b2c3d4} 的首都

export const MAPS_HEADER = "# History Logging — maps";

// One occlusion frame on a map: a rectangle in image-relative fractions
// (0–1, so zoom / resolution never desyncs it) plus a free-markdown answer
// (`{db …}` markers welcome). An optional single-line front question and
// hint override the auto-generated card front. The id is stable across
// edits so per-frame quiz progress survives adding / removing other frames.
export interface MapOcclusion {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	question: string;
	hint: string;
	answer: string;
}

export interface MapEntry {
	id: string;
	title: string;
	// Vault path / link target of the image (no `![[ ]]` wrapper, no size).
	image: string;
	// Linked event ids (events.md) and entity ids (entities.md). The map's
	// place in time is derived from its linked events' year tags.
	events: string[];
	entities: string[];
	// Free multi-value tags, same semantics as entity tags.
	tags: string[];
	updated?: string;
	// Free markdown annotation.
	body: string;
	// Occlusion-quiz frames drawn over the image.
	occlusions: MapOcclusion[];
}

// A title that merely repeats the image file name (or path) is treated as
// unnamed — pasting used to prefill it with the basename.
export function mapDisplayTitle(map: MapEntry): string {
	const t = map.title.trim();
	if (!t) return "";
	const base =
		map.image
			.split(/[\\/]/)
			.pop()
			?.replace(/\.[^.]+$/, "") ?? "";
	return t === base || t === map.image ? "" : t;
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
		events: [],
		entities: [],
		tags: [],
		body: "",
		occlusions: [],
	};
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const field =
			/^(title|image|range|events|entities|tags|updated):\s*(.*)$/.exec(
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
				// Legacy field from the first iteration; dropped on rewrite.
				break;
			case "events":
				entry.events = listOf(val);
				break;
			case "entities":
				entry.entities = listOf(val);
				break;
			case "tags":
				entry.tags = listOf(val);
				break;
			case "updated":
				entry.updated = val;
				break;
		}
	}
	const rest = lines.slice(i).join("\n");
	const at = rest.search(/^###\s+occlusions\s*$/im);
	if (at < 0) {
		entry.body = rest.trim();
		return entry;
	}
	const after = rest.slice(at).replace(/^###\s+occlusions\s*\n?/i, "");
	const nextSection = after.search(/^###\s+/m);
	const occBlock = nextSection >= 0 ? after.slice(0, nextSection) : after;
	const tail = nextSection >= 0 ? after.slice(nextSection) : "";
	entry.body = (rest.slice(0, at) + tail).trim();
	entry.occlusions = parseOcclusions(occBlock);
	return entry;
}

function parseOcclusions(block: string): MapOcclusion[] {
	const occlusions: MapOcclusion[] = [];
	let current: MapOcclusion | null = null;
	const answerLines: string[] = [];
	const flush = (): void => {
		if (!current) return;
		current.answer = answerLines.join("\n").trim();
		occlusions.push(current);
		current = null;
		answerLines.length = 0;
	};
	for (const line of block.split("\n")) {
		const head =
			/^-\s+([0-9a-z]{8})\s*\|\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/.exec(
				line
			);
		if (head) {
			flush();
			const nums = head.slice(2, 6).map(Number);
			if (nums.some((n) => !Number.isFinite(n))) continue;
			current = {
				id: head[1],
				x: clamp01(nums[0]),
				y: clamp01(nums[1]),
				w: clamp01(nums[2]),
				h: clamp01(nums[3]),
				question: "",
				hint: "",
				answer: "",
			};
			continue;
		}
		if (!current) continue;
		const body = line.replace(/^ {2}|^\t/, "");
		// q:/hint: lines belong to the frame header while the answer has not
		// started yet; after that they are ordinary answer text.
		if (!answerLines.some((l) => l.trim())) {
			const meta = /^(q|hint):\s*(.*)$/.exec(body);
			if (meta) {
				if (meta[1] === "q") current.question = meta[2].trim();
				else current.hint = meta[2].trim();
				continue;
			}
		}
		answerLines.push(body);
	}
	flush();
	return occlusions;
}

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

const frac = (n: number): string => n.toFixed(4);

export function serializeMapsFile(entries: Map<string, MapEntry>): string {
	const parts: string[] = [MAPS_HEADER, ""];
	const ids = Array.from(entries.keys()).sort();
	for (const id of ids) {
		const e = entries.get(id);
		if (!e) continue;
		parts.push(`## ${id}`);
		if (e.title) parts.push(`title: ${e.title}`);
		if (e.image) parts.push(`image: ${e.image}`);
		if (e.events.length) parts.push(`events: ${e.events.join(", ")}`);
		if (e.entities.length)
			parts.push(`entities: ${e.entities.join(", ")}`);
		if (e.tags.length) parts.push(`tags: ${e.tags.join(", ")}`);
		if (e.updated) parts.push(`updated: ${e.updated}`);
		parts.push("");
		if (e.body.trim()) {
			parts.push(e.body.trim());
			parts.push("");
		}
		if (e.occlusions.length) {
			parts.push("### occlusions");
			for (const o of e.occlusions) {
				parts.push(
					`- ${o.id} | ${frac(o.x)},${frac(o.y)},${frac(o.w)},${frac(
						o.h
					)}`
				);
				if (o.question.trim())
					parts.push(`  q: ${o.question.trim()}`);
				if (o.hint.trim()) parts.push(`  hint: ${o.hint.trim()}`);
				for (const line of o.answer.trim().split("\n"))
					if (line.trim() || o.answer.trim()) parts.push(`  ${line}`);
			}
			parts.push("");
		}
	}
	return parts.join("\n");
}
