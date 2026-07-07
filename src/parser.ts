// Parse and manipulate the inline `{ev <id> #tag }` event syntax.
//
//   {ev k7f3a9x1 #ad/07/1/0 }
//
// Exactly one year tag per marker (one tag, one id). The opening keyword `ev`
// keeps this grammar disjoint from the annotation plugin's `{;; ... }`.

import { EvMark } from "./types";
import { YEAR_TAG_SRC } from "./year-tag";

const EV_SRC = String.raw`\{ev\s+([0-9a-z]{8})\s+(` + YEAR_TAG_SRC + String.raw`)\s*\}`;

export function evRegex(): RegExp {
	return new RegExp(EV_SRC, "g");
}

export function parseEvMarks(content: string): EvMark[] {
	const re = evRegex();
	const out: EvMark[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		out.push({ id: m[1], tag: m[2], fullMatch: m[0], index: m.index });
	}
	return out;
}

// Collect all ev ids present in the content (for uniqueness checks).
export function evIdsIn(content: string): Set<string> {
	return new Set(parseEvMarks(content).map((e) => e.id));
}

// Wrap a bare year tag occurrence (at [start, end)) into `{ev <id> #tag }`.
// Returns the new content, or null if the slice is not a bare year tag or is
// already inside an ev marker.
export function wrapTagAt(
	content: string,
	start: number,
	end: number,
	id: string
): string | null {
	const tag = content.slice(start, end);
	if (!new RegExp("^" + YEAR_TAG_SRC + "$").test(tag)) return null;
	// Guard: don't double-wrap if already preceded by `{ev <id> `.
	const before = content.slice(Math.max(0, start - 40), start);
	if (/\{ev\s+[0-9a-z]{8}\s+$/.test(before)) return null;
	const wrapped = `{ev ${id} ${tag} }`;
	return content.slice(0, start) + wrapped + content.slice(end);
}

// Remove the ev wrapper for a given id, leaving the bare tag behind.
export function unwrapEv(content: string, id: string): string {
	const re = new RegExp(
		String.raw`\{ev\s+` + id + String.raw`\s+(` + YEAR_TAG_SRC + String.raw`)\s*\}`
	);
	return content.replace(re, "$1");
}
