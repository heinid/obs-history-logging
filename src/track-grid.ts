import { setIcon } from "obsidian";
import { TimelineEntry } from "./scan";
import { describeYear, parseYearTag, truncateTag } from "./year-tag";
import { EraSystem, eraAt } from "./eras";
import { matchesQuery, parseQuery } from "./query";
import { GroupBy } from "./profiles";

// One column of the in-view comparison grid: its own filter + lens.
// The grid itself provides the shared time rows, so alignment is exact.
export interface TrackDef {
	filter: string;
	lens: string;
	profile: string;
}

export function trackLabel(t: TrackDef, i: number): string {
	return t.profile || t.filter || `Track ${i + 1}`;
}

export function trackEntries(
	entries: TimelineEntry[],
	track: TrackDef
): TimelineEntry[] {
	const pq = parseQuery(track.filter);
	return entries.filter((e) => {
		const hay = `${e.tag} ${e.snippet} ${e.summary ?? ""}`.toLowerCase();
		return matchesQuery(hay, pq);
	});
}

// Renders the multi-track comparison grid: shared time-segment rows (century
// or decade) crossing per-track columns. Each row spans every column, so the
// tracks stay exactly year-aligned under a single scrollbar; empty cells show
// each track's sparse stretches at a glance. Per-track era names (the lens)
// appear as bands inside their own column.
export function renderTrackGrid(opts: {
	list: HTMLElement;
	entries: TimelineEntry[];
	tracks: TrackDef[];
	active: number;
	groupBy: GroupBy;
	eraSystems: EraSystem[];
	renderCard: (parent: HTMLElement, entry: TimelineEntry) => void;
	onActivate: (i: number) => void;
	onRemove: (i: number) => void;
}): number[] {
	const { list, tracks } = opts;
	const gb = opts.groupBy === "none" ? "century" : opts.groupBy;

	const perTrack = tracks.map((t) => trackEntries(opts.entries, t));

	type Seg = { key: number; label: string; cells: TimelineEntry[][] };
	const segMap = new Map<string, Seg>();
	perTrack.forEach((entries, ti) => {
		for (const e of entries) {
			const truncated = truncateTag(e.tag, gb) ?? e.tag;
			const gd = parseYearTag(truncated) ?? e.decoded;
			const label = describeYear(gd);
			let seg = segMap.get(label);
			if (!seg) {
				seg = { key: gd.sortKey, label, cells: tracks.map(() => []) };
				segMap.set(label, seg);
			}
			seg.cells[ti].push(e);
		}
	});
	const segs = [...segMap.values()].sort((a, b) => a.key - b.key);

	const scroller = list.createDiv({ cls: "hl-multi-scroll" });
	const grid = scroller.createDiv({ cls: "hl-multi-grid" });
	grid.style.gridTemplateColumns = `repeat(${tracks.length}, minmax(260px, 1fr))`;

	tracks.forEach((t, i) => {
		const head = grid.createDiv({ cls: "hl-track-head" });
		head.toggleClass("hl-track-active", i === opts.active);
		head.createSpan({ cls: "hl-track-name", text: trackLabel(t, i) });
		head.createSpan({ cls: "hl-track-count", text: String(perTrack[i].length) });
		head.setAttr("aria-label", "Edit this track's filter and lens in the bar");
		head.addEventListener("click", () => opts.onActivate(i));
		if (tracks.length > 1) {
			const x = head.createEl("button", { cls: "hl-icon-btn hl-track-x" });
			setIcon(x, "x");
			x.setAttr("aria-label", "Remove track");
			x.addEventListener("click", (e) => {
				e.stopPropagation();
				opts.onRemove(i);
			});
		}
	});

	const systems = tracks.map((t) =>
		t.lens ? opts.eraSystems.find((s) => s.name === t.lens) ?? null : null
	);
	const lastEra: (string | null)[] = tracks.map(() => null);

	for (const seg of segs) {
		const row = grid.createEl("h3", { cls: "hl-group hl-row-label" });
		row.createSpan({ text: seg.label });
		for (let ti = 0; ti < tracks.length; ti++) {
			const cell = grid.createDiv({ cls: "hl-cell" });
			cell.toggleClass("hl-cell-active", ti === opts.active);
			for (const e of seg.cells[ti]) {
				const sys = systems[ti];
				if (sys) {
					const hit = eraAt(sys, e.decoded.sortKey);
					const eraName = hit?.name ?? null;
					if (eraName && eraName !== lastEra[ti]) {
						const band = cell.createDiv({ cls: "hl-era-band" });
						band.createSpan({ text: eraName });
						if (hit?.range)
							band.createSpan({ cls: "hl-group-range", text: hit.range });
					}
					lastEra[ti] = eraName;
				}
				opts.renderCard(cell, e);
			}
		}
	}

	return perTrack.map((e) => e.length);
}
