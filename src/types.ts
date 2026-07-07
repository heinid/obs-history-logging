// Shared type definitions for History Logging.

export type Era = "ad" | "bc";

export type Precision = "century" | "decade" | "year";

// A decoded year tag such as `#ad/07/1/0`.
export interface DecodedYear {
	era: Era;
	// Positive magnitude of the year (e.g. 710 for both 710 AD and 710 BC).
	magnitude: number;
	// Signed sort key: AD is positive, BC is negative. Equals the earliest
	// year of the bucket so coarse tags sort before what they contain.
	sortKey: number;
	precision: Precision;
	// Inclusive signed span [earliest, latest] the tag covers on the timeline.
	span: [number, number];
}

// An inline `{ev <id> #tag }` marker found in a note.
export interface EvMark {
	id: string;
	tag: string;
	// The full matched text, e.g. `{ev k7f3a9x1 #ad/07/1/0 }`.
	fullMatch: string;
	// Character offset of the match start within the (LF-normalised) content.
	index: number;
}

// One event record persisted in `events.md`, keyed by its `ev` id.
export interface EventEntry {
	id: string;
	// Human-readable label of the year tag this event is attached to. Purely
	// for readability of events.md; the note's inline tag is authoritative.
	tag?: string;
	// ISO date the entry was last written.
	updated?: string;
	// Markdown summary / narrative body.
	summary: string;
}
