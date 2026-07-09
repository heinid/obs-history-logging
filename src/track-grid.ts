import { setIcon } from "obsidian";
import { TimelineEntry } from "./scan";
import { describeYear } from "./year-tag";
import { DecodedYear } from "./types";
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

// A jump target for the era navigator: where an era starts in a column.
export interface EraAnchor {
	name: string;
	range: string;
	count: number;
	el: HTMLElement;
}

// Renders the multi-track comparison grid: shared time-segment rows (century
// or decade) crossing per-track columns. Rows are keyed by their numeric
// bucket start on the absolute axis — never by display label — so two
// different periods can never merge, and the tracks stay exactly year-aligned
// under a single scrollbar. Each lensed track shows its civilization's FULL
// era sequence as a textbook-style gutter: one continuous rounded band per
// era running down the column's left edge, its name written vertically —
// present even when the track has no entries there. `relayout` repositions
// the bands; call it whenever the grid's geometry changes.
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
}): { counts: number[]; eraAnchors: EraAnchor[][]; relayout: () => void } {
	const { list, tracks } = opts;
	const gb = opts.groupBy === "none" ? "century" : opts.groupBy;
	const span = gb === "century" ? 100 : 10;

	const perTrack = tracks.map((t) => trackEntries(opts.entries, t));
	const systems = tracks.map((t) =>
		t.lens ? opts.eraSystems.find((s) => s.name === t.lens) ?? null : null
	);

	// The bucket (shared row) containing a point on the absolute axis. AD
	// buckets start at their round year; BC spans are flipped, so the bucket
	// key is the earlier (more negative) end.
	const bucketKey = (sortKey: number): number => {
		if (sortKey >= 0) return Math.floor(sortKey / span) * span;
		const magStart = Math.floor(-sortKey / span) * span;
		return -(magStart + span - 1);
	};
	const bucketLabel = (key: number): string => {
		const d: DecodedYear =
			key >= 0
				? {
						era: "ad",
						magnitude: key,
						sortKey: key,
						precision: gb,
						span: [key, key + span - 1],
				  }
				: {
						era: "bc",
						magnitude: -key - (span - 1),
						sortKey: key,
						precision: gb,
						span: [key, key + span - 1],
				  };
		return describeYear(d);
	};

	type Seg = { key: number; end: number; label: string; cells: TimelineEntry[][] };
	const segMap = new Map<number, Seg>();
	const ensureSeg = (key: number): Seg => {
		let seg = segMap.get(key);
		if (!seg) {
			seg = {
				key,
				end: key + span - 1,
				label: bucketLabel(key),
				cells: tracks.map(() => []),
			};
			segMap.set(key, seg);
		}
		return seg;
	};
	perTrack.forEach((entries, ti) => {
		for (const e of entries)
			ensureSeg(bucketKey(e.decoded.sortKey)).cells[ti].push(e);
	});
	// Every era boundary gets a row, so eras without entries still show up.
	systems.forEach((sys) => {
		if (!sys) return;
		for (const b of sys.boundaries) ensureSeg(bucketKey(b.startKey));
	});
	const segs = [...segMap.values()].sort((a, b) => a.key - b.key);

	// Entries per era, shown in the bands and the navigator.
	const eraCounts = tracks.map((_, ti) => {
		const counts = new Map<string, number>();
		const sys = systems[ti];
		if (sys)
			for (const e of perTrack[ti]) {
				const name = eraAt(sys, e.decoded.sortKey)?.name;
				if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
			}
		return counts;
	});

	const scroller = list.createDiv({ cls: "hl-multi-scroll" });
	const grid = scroller.createDiv({ cls: "hl-multi-grid" });
	grid.style.gridTemplateColumns = `repeat(${tracks.length}, minmax(260px, 1fr))`;

	tracks.forEach((t, i) => {
		const head = grid.createDiv({ cls: "hl-track-head" });
		head.setAttr("data-track", String(i));
		head.toggleClass("hl-track-active", i === opts.active);
		head.createSpan({ cls: "hl-track-name", text: trackLabel(t, i) });
		head.createSpan({ cls: "hl-track-count", text: String(perTrack[i].length) });
		head.setAttr("aria-label", "Edit this track's filter and lens in the bar");
		head.addEventListener("click", () => opts.onActivate(i));
		// Middle-click a head to close its track, like a browser tab.
		head.addEventListener("auxclick", (e) => {
			if (e.button === 1 && tracks.length > 1) {
				e.preventDefault();
				opts.onRemove(i);
			}
		});
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

	const nextBoundary = tracks.map(() => 0);
	const eraAnchors: EraAnchor[][] = tracks.map(() => []);
	// Where each era begins: the cell of the row containing its start year.
	const gutters: {
		ti: number;
		startCell: HTMLElement;
		el: HTMLElement;
	}[] = [];

	for (const seg of segs) {
		const row = grid.createEl("h3", { cls: "hl-group hl-row-label" });
		row.createSpan({ text: seg.label });
		for (let ti = 0; ti < tracks.length; ti++) {
			const cell = grid.createDiv({ cls: "hl-cell" });
			cell.setAttr("data-track", String(ti));
			// Clicking anywhere in a column focuses its track in the bar.
			cell.addEventListener("click", () => opts.onActivate(ti));
			const sys = systems[ti];
			if (sys) cell.addClass("hl-has-gutter");
			const emitBand = (): void => {
				if (!sys) return;
				const b = sys.boundaries[nextBoundary[ti]];
				const hit = eraAt(sys, b.startKey);
				if (!hit) return;
				const count = eraCounts[ti].get(hit.name) ?? 0;
				const band = grid.createDiv({ cls: "hl-era-gutter" });
				band.toggleClass("hl-era-empty", count === 0);
				band.setAttr("aria-label", `${hit.name} ${hit.range} — ${count}`);
				const label = band.createDiv({ cls: "hl-era-gutter-label" });
				label.createSpan({ cls: "hl-era-name", text: hit.name });
				if (count > 0)
					label.createSpan({ cls: "hl-era-count", text: String(count) });
				band.addEventListener("click", () => opts.onActivate(ti));
				gutters.push({ ti, startCell: cell, el: band });
				eraAnchors[ti].push({ name: hit.name, range: hit.range, count, el: band });
			};
			if (sys) {
				for (const e of seg.cells[ti]) {
					while (
						nextBoundary[ti] < sys.boundaries.length &&
						sys.boundaries[nextBoundary[ti]].startKey <= e.decoded.sortKey
					) {
						emitBand();
						nextBoundary[ti]++;
					}
					opts.renderCard(cell, e);
				}
				while (
					nextBoundary[ti] < sys.boundaries.length &&
					sys.boundaries[nextBoundary[ti]].startKey <= seg.end
				) {
					emitBand();
					nextBoundary[ti]++;
				}
			} else {
				for (const e of seg.cells[ti]) opts.renderCard(cell, e);
			}
		}
	}

	// Size and place the gutter bands: each era's band runs from the top of
	// the row where it starts to the top of its successor's (the last one to
	// the grid's bottom edge). Offsets are measured against the grid, so the
	// bands survive horizontal scrolling; re-run whenever geometry changes
	// (cards expanding, images loading, pane resizes).
	const relayout = (): void => {
		const perTi = new Map<number, typeof gutters>();
		for (const g of gutters) {
			const arr = perTi.get(g.ti) ?? [];
			arr.push(g);
			perTi.set(g.ti, arr);
		}
		for (const arr of perTi.values()) {
			for (let i = 0; i < arr.length; i++) {
				const g = arr[i];
				const top = g.startCell.offsetTop;
				const end =
					i + 1 < arr.length
						? arr[i + 1].startCell.offsetTop - 6
						: grid.scrollHeight - 8;
				g.el.style.left = `${g.startCell.offsetLeft}px`;
				g.el.style.top = `${top}px`;
				g.el.style.height = `${Math.max(end - top, 22)}px`;
			}
		}
	};
	relayout();

	return { counts: perTrack.map((e) => e.length), eraAnchors, relayout };
}
