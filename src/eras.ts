// Named historical eras, persisted in `_chronology/eras.md`. An era is a named
// span on the unified BC/AD axis; the timeline can group by era instead of by
// bare century so sparse ancient notes read as "Republican Rome" rather than a
// long run of one-card "Nth c. BC" headings.
//
//   # History Logging — eras
//
//   ## Republican Rome
//   range: 509 BC – 27 BC
//
//   ## 奈良時代
//   range: 710 – 794
//
// Format mirrors events.md / profiles.md: `## <name>` + `key: value` lines.

export interface Era {
	name: string;
	startKey: number; // absolute-axis sortKey, inclusive (AD +, BC -)
	endKey: number; // absolute-axis sortKey, inclusive
	range: string; // original range text, for display
}

export const ERAS_HEADER = "# History Logging — eras";

// Parse an absolute year like "509 BC", "27 BC", "476 AD" or a bare "710"
// (assumed AD) into a sortKey on the unified axis. There is no year zero.
export function parseAbsYear(s: string): number | null {
	const m = /^\s*(\d+)\s*(bc|ad|ce|bce)?\s*$/i.exec(s);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	if (Number.isNaN(n) || n === 0) return null;
	const era = (m[2] ?? "ad").toLowerCase();
	return era === "bc" || era === "bce" ? -n : n;
}

// Parse a "start – end" range. Accepts en/em dash, hyphen, tilde or "to".
function parseRange(s: string): { startKey: number; endKey: number } | null {
	const parts = s.split(/\s*(?:–|—|~|-|\bto\b)\s*/i).filter((p) => p.trim());
	if (parts.length !== 2) return null;
	const a = parseAbsYear(parts[0]);
	const b = parseAbsYear(parts[1]);
	if (a === null || b === null) return null;
	return { startKey: Math.min(a, b), endKey: Math.max(a, b) };
}

export function parseErasFile(content: string): Era[] {
	const normalised = content.replace(/\r\n/g, "\n");
	const re = /^##\s+(.+?)\s*$/gm;
	const heads: { name: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null) {
		heads.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
	}
	const eras: Era[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const block = normalised.slice(h.bodyStart, end);
		let range = "";
		for (const line of block.split("\n")) {
			const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
			if (kv && kv[1] === "range") range = kv[2].trim();
		}
		const parsed = parseRange(range);
		if (parsed) eras.push({ name: h.name, range, ...parsed });
	}
	// Earliest first, mirroring the timeline's own ordering.
	eras.sort((a, b) => a.startKey - b.startKey);
	return eras;
}

// Find the era containing a point on the absolute axis. When ranges overlap the
// one with the latest (narrowest) start wins, so a sub-era beats its parent.
export function eraFor(eras: Era[], sortKey: number): Era | null {
	let best: Era | null = null;
	for (const e of eras) {
		if (sortKey >= e.startKey && sortKey <= e.endKey) {
			if (!best || e.startKey > best.startKey) best = e;
		}
	}
	return best;
}
