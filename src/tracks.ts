// Track classification: `#histolog/<track>` tags assign an entry to one or
// more tracks (datasets/columns) — orthogonal to the era-system lens, which
// only renames the axis's segments. A track tag inside a dated block
// classifies that block; a track tag standing alone (in a block without any
// year tag) declares a file-wide default for blocks with no track of their own.

export const TRACK_TAG_PREFIX = "#histolog/";

const TRACK_RE = /(^|[^\S\n]|\n)#histolog\/([^\s#]+)/g;

// Unique track names mentioned in `text`, in order of first appearance.
export function tracksIn(text: string): string[] {
	return dedupe(trackMatches(text).map((t) => t.name));
}

// Every track-tag occurrence with its char offset, for block-level analysis.
export function trackMatches(text: string): { name: string; index: number }[] {
	const out: { name: string; index: number }[] = [];
	let m: RegExpExecArray | null;
	TRACK_RE.lastIndex = 0;
	while ((m = TRACK_RE.exec(text)) !== null) {
		out.push({ name: m[2], index: m.index + m[1].length });
	}
	return out;
}

export function dedupe(names: string[]): string[] {
	const out: string[] = [];
	for (const n of names) if (!out.includes(n)) out.push(n);
	return out;
}

// Sentinel shown in the UI for entries with no track tag at all.
export const UNTRACKED = "";
