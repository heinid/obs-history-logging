// Named era SYSTEMS, persisted in `_chronology/eras.md`. A *system* is one
// civilization's complete, sequential chronology (Japan, China, Britain, Rome…);
// picking a system lays it over the shared BC/AD axis as a grouping *lens* — it
// renames the axis's segments, it does not filter which notes are shown.
//
//   # History Logging — era systems
//
//   ## 日本史
//   710  奈良時代
//   794  平安時代
//   1185 鎌倉時代
//
//   ## ローマ史
//   753 BC 王政ローマ
//   509 BC 共和政ローマ
//   27 BC  ローマ帝国
//   476    西ローマ帝国滅亡後
//
// A system is expressed as a list of BOUNDARY points: each era begins at its
// year and runs until the next boundary. That makes a system a clean partition
// of the axis — no gaps, no overlaps — and editing one boundary moves one
// number. Format mirrors events.md / profiles.md (`## <system>` sections).

export interface EraBoundary {
	startKey: number; // absolute-axis sortKey where this era begins
	yearLabel: string; // original "710" / "509 BC" text, for display
	name: string;
}

export interface EraSystem {
	name: string;
	boundaries: EraBoundary[]; // ascending by startKey
}

export const ERAS_HEADER = "# History Logging — era systems";

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

// Render a sortKey back to a compact label: 710 -> "710", -509 -> "509 BC".
export function formatAbsYear(key: number): string {
	return key < 0 ? `${-key} BC` : `${key}`;
}

const BOUNDARY_RE = /^(\d+)\s*(bc|ad|bce|ce)?\s+(.+?)\s*$/i;

export function parseErasFile(content: string): EraSystem[] {
	const normalised = content.replace(/\r\n/g, "\n");
	const re = /^##\s+(.+?)\s*$/gm;
	const heads: { name: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null) {
		heads.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
	}
	const systems: EraSystem[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const block = normalised.slice(h.bodyStart, end);
		const boundaries: EraBoundary[] = [];
		for (const line of block.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const bm = BOUNDARY_RE.exec(trimmed);
			if (!bm) continue;
			const yearLabel = `${bm[1]}${bm[2] ? ` ${bm[2].toUpperCase()}` : ""}`;
			const startKey = parseAbsYear(yearLabel);
			if (startKey === null) continue;
			boundaries.push({ startKey, yearLabel, name: bm[3] });
		}
		boundaries.sort((a, b) => a.startKey - b.startKey);
		systems.push({ name: h.name, boundaries });
	}
	return systems;
}

export function serializeErasFile(systems: EraSystem[]): string {
	const parts: string[] = [ERAS_HEADER, ""];
	for (const sys of systems) {
		parts.push(`## ${sys.name}`);
		for (const b of [...sys.boundaries].sort((a, c) => a.startKey - c.startKey)) {
			parts.push(`${b.yearLabel} ${b.name}`);
		}
		parts.push("");
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}

export interface EraHit {
	name: string;
	startKey: number;
	endKey: number | null; // exclusive next boundary; null = open-ended
	range: string; // display, e.g. "710 – 793"
}

// Locate the era of `system` that contains a point on the absolute axis. The
// era is the boundary with the greatest startKey <= sortKey; it runs until the
// next boundary. Points before the first boundary are outside coverage (null).
export function eraAt(system: EraSystem, sortKey: number): EraHit | null {
	const bs = system.boundaries;
	let idx = -1;
	for (let i = 0; i < bs.length; i++) {
		if (bs[i].startKey <= sortKey) idx = i;
		else break;
	}
	if (idx < 0) return null;
	const cur = bs[idx];
	const next = bs[idx + 1];
	const endKey = next ? next.startKey : null;
	const endLabel = next ? formatAbsYear(next.startKey - 1) : "…";
	return {
		name: cur.name,
		startKey: cur.startKey,
		endKey,
		range: `${cur.yearLabel} – ${endLabel}`,
	};
}
