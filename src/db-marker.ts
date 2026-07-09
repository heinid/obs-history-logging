// Parse and manipulate the inline `{db <id> <text>}` entity marker used
// inside event summaries.
//
//   元寇（1274・1281）— {db q3x8k2p1 フビライ}の日本遠征…
//
// The marker binds a stretch of summary text (its display form) to an entity
// entry in entities.md. Rendering folds the marker away, leaving the text
// with a coloured underline. The grammar is disjoint from `{ev …}`.

import { EntityEntry, displayName } from "./db-format";

const DB_SRC = String.raw`\{db\s+([0-9a-z][0-9a-z_-]{1,63})\s+([^{}]*?)\s*\}`;

export interface DbMark {
	id: string;
	text: string;
	fullMatch: string;
	index: number;
}

export function dbRegex(): RegExp {
	return new RegExp(DB_SRC, "g");
}

export function makeDbMarker(id: string, text: string): string {
	return `{db ${id} ${text}}`;
}

export function parseDbMarks(content: string): DbMark[] {
	const re = dbRegex();
	const out: DbMark[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null)
		out.push({ id: m[1], text: m[2], fullMatch: m[0], index: m.index });
	return out;
}

// Fold every `{db <id> <text>}` down to its display text.
export function stripDbMarkers(text: string): string {
	return text.replace(dbRegex(), "$2");
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Replace markers with inline HTML spans the markdown renderer passes
// through, so summaries in timeline cards show the folded, clickable form.
// Colors come from the entity's type; unknown ids render as plain text.
export function dbMarkersToHtml(
	text: string,
	colorFor: (id: string) => string | null
): string {
	return text.replace(dbRegex(), (_m, id: string, word: string) => {
		const color = colorFor(id);
		if (color === null) return escapeHtml(word);
		const safe = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : "";
		const style = safe ? ` style="text-decoration-color: ${safe}"` : "";
		return `<span class="hl-db-ref" data-db-id="${id}"${style}>${escapeHtml(
			word
		)}</span>`;
	});
}

// --- recognition / completion -----------------------------------------

export interface AliasHit {
	entity: EntityEntry;
	alias: string;
}

// Deterministic longest-match recognition: find the longest entity label
// (any language) that the text before the cursor ends with. Returns null
// when the cursor is inside an (unclosed) `{db …}` marker so completion
// never fires within an existing annotation.
export function aliasAtCursor(
	before: string,
	entities: Iterable<EntityEntry>
): AliasHit | null {
	const open = before.lastIndexOf("{db");
	if (open >= 0 && before.indexOf("}", open) < 0) return null;
	let best: AliasHit | null = null;
	for (const entity of entities) {
		for (const l of entity.labels) {
			const alias = l.text;
			if (!alias || alias.length < 2) continue;
			if (!before.endsWith(alias)) continue;
			if (best && alias.length <= best.alias.length) continue;
			// Word boundary for spaced scripts: the char before the alias must
			// not be a word char of the same kind (Latin letters / digits).
			const prev = before[before.length - alias.length - 1];
			if (
				prev !== undefined &&
				/[A-Za-z0-9]/.test(prev) &&
				/^[A-Za-z0-9]/.test(alias)
			)
				continue;
			best = { entity, alias };
		}
	}
	return best;
}

export interface AliasCandidate {
	entity: EntityEntry;
	alias: string;
	// The fragment before the cursor that matches the alias (a prefix of it,
	// possibly the whole alias). Replaced by the marker on confirm.
	matched: string;
	exact: boolean;
}

// Multi-candidate completion: every alias (any language) that starts with a
// fragment the text before the cursor ends with. Longer matched fragments
// rank first, exact matches before prefixes. Returns [] inside an unclosed
// `{db …}` marker.
export function aliasCandidates(
	before: string,
	entities: Iterable<EntityEntry>,
	limit = 8
): AliasCandidate[] {
	const open = before.lastIndexOf("{db");
	if (open >= 0 && before.indexOf("}", open) < 0) return [];
	const out: AliasCandidate[] = [];
	for (const entity of entities) {
		let best: AliasCandidate | null = null;
		for (const l of entity.labels) {
			const alias = l.text;
			if (!alias || alias.length < 2) continue;
			// Longest suffix of `before` that is a prefix of `alias`.
			let n = Math.min(alias.length, before.length);
			for (; n > 0; n--)
				if (before.endsWith(alias.slice(0, n))) break;
			if (n === 0) continue;
			const matched = alias.slice(0, n);
			// A single Latin letter matches too much; CJK chars carry enough
			// signal on their own.
			if (matched.length < 2 && /^[\x00-\xff]+$/.test(matched)) continue;
			// Word boundary for spaced scripts.
			const prev = before[before.length - n - 1];
			if (
				prev !== undefined &&
				/[A-Za-z0-9]/.test(prev) &&
				/^[A-Za-z0-9]/.test(matched)
			)
				continue;
			const cand: AliasCandidate = {
				entity,
				alias,
				matched,
				exact: n === alias.length,
			};
			if (
				!best ||
				cand.matched.length > best.matched.length ||
				(cand.matched.length === best.matched.length &&
					cand.exact &&
					!best.exact)
			)
				best = cand;
		}
		if (best && (best.exact || best.matched.length >= 1)) out.push(best);
	}
	out.sort(
		(a, b) =>
			b.matched.length - a.matched.length ||
			Number(b.exact) - Number(a.exact) ||
			a.alias.length - b.alias.length
	);
	return out.slice(0, limit);
}

// All searchable text of an entity, for fuzzy pickers.
export function entitySearchText(e: EntityEntry): string {
	return [
		displayName(e),
		...e.labels.map((l) => l.text),
		...e.readings.map((r) => r.text),
		e.type,
		...e.tags,
	].join(" ");
}
