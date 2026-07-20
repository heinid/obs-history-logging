// Occurrences of one entity's `{db id …}` markers inside vault notes.
//
// Pure text-level scanning so it is testable outside Obsidian. A marker may
// be wrapped in the companion highlight syntax `~={color|fn:xxxx}{db …}=~`;
// the wrapping `fn:xxxx` id keys a `[xxxx.date]: <ISO>` line in the file's
// bottom annotations block, which dates when the entity was FIRST annotated
// in that file (only the first occurrence gets a wrap).

import { dbRegex } from "./db-marker";

// Replace every occurrence of any label (longest first, case-insensitive)
// with a blank — context hints must not spoil the recalled spelling.
export function maskLabels(snippet: string, labels: string[]): string {
	const cleaned = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
	cleaned.sort((a, b) => b.length - a.length);
	let out = snippet;
	for (const label of cleaned) {
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(escaped, "gi"), "____");
	}
	return out.replace(/(?:____\s*)+/g, "____ ");
}

export interface NoteOccurrence {
	offset: number; // char offset of the marker (LF-normalised)
	length: number; // marker length, for jump selection
	snippet: string; // cleaned text of the containing line
	raw: string; // containing line with `{db …}` markers preserved
	fnId?: string; // wrapping highlight id, when present
}

export interface NoteOccurrences {
	occurrences: NoteOccurrence[];
	// Earliest `[fnid.date]:` value among wrapped occurrences.
	firstAnnotated?: string;
}

const FN_WRAP_BEFORE = /~=\{[^{}|]*\|fn:([0-9a-z]+)\}$/;

// `[xxxx.date]: 2026-07-15T00:40:48.723Z` metadata lines.
function annotationDates(content: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /^\[([0-9a-z]+)\.date\]:\s*(\S+)\s*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) out.set(m[1], m[2]);
	return out;
}

// The line as renderable markdown: `{db …}` markers kept intact so it can
// go through the same rendering pipeline as notes/summaries; the highlight
// wrapper, `{;; …}` line notes and `{ev …}` marks removed.
function rawLine(line: string): string {
	return line
		.replace(/~=\{[^{}]*\}/g, "")
		.replace(/=~/g, "")
		.replace(/\{;;[^{}]*\}/g, "")
		.replace(/\{ev\s+[^{}]*\}/g, "")
		.replace(/^#{1,6}\s+/, "")
		.replace(/^\s*[-*]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

// The line's text cleaned for display: markers folded to their text, the
// highlight wrapper, `{;; …}` line notes and `{ev …}` marks removed.
function cleanLine(line: string): string {
	return line
		.replace(dbRegex(), "$2")
		.replace(/~=\{[^{}]*\}/g, "")
		.replace(/=~/g, "")
		.replace(/\{;;[^{}]*\}/g, "")
		.replace(/\{ev\s+[^{}]*\}/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}

export function scanNoteOccurrences(
	content: string,
	entityId: string
): NoteOccurrences {
	const text = content.replace(/\r\n/g, "\n");
	const occurrences: NoteOccurrence[] = [];
	const dates = annotationDates(text);
	let firstAnnotated: string | undefined;
	const re = dbRegex();
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m[1] !== entityId) continue;
		const lineStart = text.lastIndexOf("\n", m.index) + 1;
		const lineEndIdx = text.indexOf("\n", m.index);
		const line = text.slice(
			lineStart,
			lineEndIdx === -1 ? text.length : lineEndIdx
		);
		const wrap = FN_WRAP_BEFORE.exec(text.slice(lineStart, m.index));
		const fnId =
			wrap && text.startsWith("=~", m.index + m[0].length)
				? wrap[1]
				: undefined;
		occurrences.push({
			offset: m.index,
			length: m[0].length,
			snippet: cleanLine(line),
			raw: rawLine(line),
			fnId,
		});
		if (fnId) {
			const date = dates.get(fnId);
			if (date && (!firstAnnotated || date < firstAnnotated))
				firstAnnotated = date;
		}
	}
	return { occurrences, firstAnnotated };
}
