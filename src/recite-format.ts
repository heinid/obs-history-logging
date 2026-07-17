// Entity-recitation "direction decks" persisted in `_chronology/recite-decks.md`.
// A deck defines a recall direction: show the source-language spelling of an
// entity and recall its target-language spelling(s), optionally scoped by
// entity tags / types. Format mirrors profiles.md: `## <name>` + `key: value`.
//
//   # History Logging — recitation decks
//
//   ## 日本史 · 中→日
//   from: zh
//   to: ja, en
//   tags: 日本史
//   types: person, polity

import { EntityEntry } from "./db-format";

export interface ReciteDeck {
	name: string;
	from: string; // source language code
	to: string[]; // target language codes (recall these)
	tags: string[]; // entity must carry one of these tags (empty = any)
	types: string[]; // entity must be one of these types (empty = any)
}

export const RECITE_DECKS_HEADER = "# History Logging — recitation decks";

function splitList(v: string): string[] {
	return v
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function parseReciteDecksFile(content: string): ReciteDeck[] {
	const normalised = content.replace(/\r\n/g, "\n");
	const re = /^##\s+(.+?)\s*$/gm;
	const heads: { name: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null)
		heads.push({
			name: m[1],
			start: m.index,
			bodyStart: m.index + m[0].length,
		});
	const decks: ReciteDeck[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const block = normalised.slice(h.bodyStart, end);
		const deck: ReciteDeck = {
			name: h.name,
			from: "",
			to: [],
			tags: [],
			types: [],
		};
		for (const line of block.split("\n")) {
			const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
			if (!kv) continue;
			const val = kv[2].trim();
			if (kv[1] === "from") deck.from = val.toLowerCase();
			else if (kv[1] === "to")
				deck.to = splitList(val.toLowerCase());
			else if (kv[1] === "tags") deck.tags = splitList(val);
			else if (kv[1] === "types") deck.types = splitList(val);
		}
		decks.push(deck);
	}
	return decks;
}

export function serializeReciteDecksFile(decks: ReciteDeck[]): string {
	const parts = [RECITE_DECKS_HEADER, ""];
	for (const d of decks) {
		parts.push(`## ${d.name}`);
		parts.push(`from: ${d.from}`);
		parts.push(`to: ${d.to.join(", ")}`);
		if (d.tags.length) parts.push(`tags: ${d.tags.join(", ")}`);
		if (d.types.length) parts.push(`types: ${d.types.join(", ")}`);
		parts.push("");
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}

function normTag(t: string): string {
	return t.replace(/^#+/, "").trim().toLowerCase();
}

// Whether an entity qualifies for a deck: has a source-language label, has a
// label in at least one target language, and passes the tag / type scopes.
export function entityMatchesDeck(e: EntityEntry, deck: ReciteDeck): boolean {
	if (!deck.from || !deck.to.length) return false;
	if (!e.labels.some((l) => l.lang === deck.from && l.text.trim()))
		return false;
	if (!e.labels.some((l) => deck.to.includes(l.lang) && l.text.trim()))
		return false;
	if (deck.types.length && !deck.types.includes(e.type)) return false;
	if (deck.tags.length) {
		const want = deck.tags.map(normTag);
		const have = e.tags.map(normTag);
		if (!have.some((t) => want.some((w) => t === w || t.startsWith(`${w}/`))))
			return false;
	}
	return true;
}

export function reciteDeckCandidates(
	entities: Iterable<EntityEntry>,
	deck: ReciteDeck
): EntityEntry[] {
	const out: EntityEntry[] = [];
	for (const e of entities) if (entityMatchesDeck(e, deck)) out.push(e);
	return out;
}
