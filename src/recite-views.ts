// Saved entity-browse views persisted in `_chronology/recite-views.md`. A
// view captures the whole browse-desk state (direction, scopes, grouping,
// sorting) and may carry a study deck: persistent per-«entity × language»
// progress for its members. Views supersede the old direction decks in
// `recite-decks.md`; those migrate 1:1 on first read.
//
//   # History Logging — recitation views
//
//   ## 日语阅读积累
//   from: zh
//   to: ja, en
//   tags: 日本史
//   types: person, polity
//   requireFrom: true
//   group: date
//   sort: created
//   study: true
//   follow: true
//   members: q3x8k2p1, a1b2c3d4

import { EntityEntry } from "./db-format";
import { ReciteDeck } from "./recite-format";

export type ViewGroup = "none" | "date" | "type" | "tag";
export type ViewSort = "created" | "updated" | "name";

export interface ReciteView {
	name: string;
	from: string;
	to: string[];
	tags: string[];
	types: string[];
	// Hide entities lacking a from-language spelling.
	requireFrom: boolean;
	group: ViewGroup;
	sort: ViewSort;
	// Whether the view carries a study deck with persistent progress.
	study: boolean;
	// Study membership is the fixed `members` list by default; opt-in
	// follow mode auto-joins every filter match.
	follow: boolean;
	// Explicitly added entity ids (kept even when follow is true, so cards
	// added under a temporary filter tweak stay members).
	members: string[];
}

export const RECITE_VIEWS_HEADER = "# History Logging — recitation views";

const GROUPS = new Set<ViewGroup>(["none", "date", "type", "tag"]);
const SORTS = new Set<ViewSort>(["created", "updated", "name"]);

export function emptyView(name = ""): ReciteView {
	return {
		name,
		from: "",
		to: [],
		tags: [],
		types: [],
		requireFrom: false,
		group: "none",
		sort: "created",
		study: false,
		follow: false,
		members: [],
	};
}

function splitList(v: string): string[] {
	return v
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function parseReciteViewsFile(content: string): ReciteView[] {
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
	const views: ReciteView[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end =
			i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const view = emptyView(h.name);
		for (const line of normalised.slice(h.bodyStart, end).split("\n")) {
			const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
			if (!kv) continue;
			const val = kv[2].trim();
			if (kv[1] === "from") view.from = val.toLowerCase();
			else if (kv[1] === "to") view.to = splitList(val.toLowerCase());
			else if (kv[1] === "tags") view.tags = splitList(val);
			else if (kv[1] === "types") view.types = splitList(val);
			else if (kv[1] === "requireFrom")
				view.requireFrom = val === "true";
			else if (kv[1] === "group" && GROUPS.has(val as ViewGroup))
				view.group = val as ViewGroup;
			else if (kv[1] === "sort" && SORTS.has(val as ViewSort))
				view.sort = val as ViewSort;
			else if (kv[1] === "study") view.study = val === "true";
			else if (kv[1] === "follow") view.follow = val === "true";
			else if (kv[1] === "members") view.members = splitList(val);
		}
		views.push(view);
	}
	return views;
}

export function serializeReciteViewsFile(views: ReciteView[]): string {
	const parts = [RECITE_VIEWS_HEADER, ""];
	for (const v of views) {
		parts.push(`## ${v.name}`);
		if (v.from) parts.push(`from: ${v.from}`);
		if (v.to.length) parts.push(`to: ${v.to.join(", ")}`);
		if (v.tags.length) parts.push(`tags: ${v.tags.join(", ")}`);
		if (v.types.length) parts.push(`types: ${v.types.join(", ")}`);
		if (v.requireFrom) parts.push("requireFrom: true");
		if (v.group !== "none") parts.push(`group: ${v.group}`);
		if (v.sort !== "created") parts.push(`sort: ${v.sort}`);
		if (v.study) parts.push("study: true");
		if (v.follow) parts.push("follow: true");
		if (v.members.length) parts.push(`members: ${v.members.join(", ")}`);
		parts.push("");
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}

// Old direction decks map 1:1 onto views (no study deck yet).
export function viewFromDeck(deck: ReciteDeck): ReciteView {
	return {
		...emptyView(deck.name),
		from: deck.from,
		to: [...deck.to],
		tags: [...deck.tags],
		types: [...deck.types],
		requireFrom: true,
	};
}

function normTag(t: string): string {
	return t.replace(/^#+/, "").trim().toLowerCase();
}

// Filter pass, ignoring requireFrom (the browse desk applies that as a
// display toggle so entities missing the spelling stay visible but flagged).
export function entityMatchesView(e: EntityEntry, view: ReciteView): boolean {
	if (view.types.length && !view.types.includes(e.type)) return false;
	if (view.tags.length) {
		const want = view.tags.map(normTag);
		const have = e.tags.map(normTag);
		if (
			!have.some((t) =>
				want.some((w) => t === w || t.startsWith(`${w}/`))
			)
		)
			return false;
	}
	return true;
}

export function hasLang(e: EntityEntry, lang: string): boolean {
	return e.labels.some((l) => l.lang === lang && l.text.trim());
}

// Entities the view's study deck covers: filter matches (when following)
// plus explicit members, all requiring the from-language spelling (a study
// card can't exist without its front).
export function studyMembers(
	entities: Iterable<EntityEntry>,
	view: ReciteView
): EntityEntry[] {
	const members = new Set(view.members);
	const out: EntityEntry[] = [];
	for (const e of entities) {
		const inFilter = view.follow && entityMatchesView(e, view);
		if (!inFilter && !members.has(e.id)) continue;
		if (!view.from || !hasLang(e, view.from)) continue;
		if (!view.to.some((lang) => hasLang(e, lang))) continue;
		out.push(e);
	}
	return out;
}
