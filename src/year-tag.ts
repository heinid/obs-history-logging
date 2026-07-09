// Encode / decode the hierarchical year-tag grammar.
//
//   #ad/07/1/0   -> 710 AD   (exact year)
//   #ad/07/1     -> 710-719  (decade bucket)
//   #ad/07       -> 700-799  (century bucket)
//   #bc/07/1/0   -> 710 BC
//
// A year is zero-padded to (at least) four digits ABCD and split positionally
// as first-two-digits / tens / ones. Joining the segments therefore reproduces
// the leading digits of the year; padding on the right yields the bucket start.

import { DecodedYear, Era, Precision } from "./types";

const TAG_RE = /^#(ad|bc)((?:\/\d+)+)$/;

// Bare year tag matcher for scanning note content. Uses lookbehind-free
// boundary handling: must be preceded by start/whitespace and followed by a
// non tag-char so `#ad/07/1/0` is matched but not partial garbage.
export const YEAR_TAG_SRC = String.raw`#(?:ad|bc)(?:/\d+)+`;

export function yearTagRegex(): RegExp {
	return new RegExp(YEAR_TAG_SRC, "g");
}

function precisionOf(digitCount: number): Precision {
	if (digitCount <= 2) return "century";
	if (digitCount === 3) return "decade";
	return "year";
}

function spanLength(precision: Precision): number {
	if (precision === "century") return 100;
	if (precision === "decade") return 10;
	return 1;
}

export function parseYearTag(tag: string): DecodedYear | null {
	const m = TAG_RE.exec(tag.trim());
	if (!m) return null;
	const era = m[1] as Era;
	const digits = m[2].replace(/\//g, "");
	if (digits.length === 0) return null;

	const precision = precisionOf(digits.length);
	const magStart = parseInt(digits.padEnd(4, "0"), 10);
	if (Number.isNaN(magStart)) return null;
	const magEnd = magStart + spanLength(precision) - 1;

	if (era === "ad") {
		return {
			era,
			magnitude: magStart,
			sortKey: magStart,
			precision,
			span: [magStart, magEnd],
		};
	}
	// BC: larger magnitude is earlier, so map to negative and flip the span.
	return {
		era,
		magnitude: magStart,
		sortKey: -magEnd,
		precision,
		span: [-magEnd, -magStart],
	};
}

// Build a canonical exact-year tag from an era + magnitude (>= 1).
export function encodeYearTag(era: Era, magnitude: number): string {
	const digits = String(Math.max(1, Math.floor(magnitude))).padStart(4, "0");
	const head = digits.slice(0, -2);
	const tens = digits.slice(-2, -1);
	const ones = digits.slice(-1);
	return `#${era}/${head}/${tens}/${ones}`;
}

// Human-readable label for a decoded year, e.g. "710", "710 BC", "710s",
// "8th c. AD". Used by the timeline view.
export function describeYear(d: DecodedYear): string {
	const suffix = d.era === "bc" ? " BC" : "";
	if (d.precision === "year") return `${d.magnitude}${suffix}`;
	if (d.precision === "decade") return `${d.magnitude}s${suffix}`;
	// Century number: the 700s span is the 8th century, AD and BC alike
	// (magnitude is the bucket start, so 100–199 BC is the 2nd century BC).
	const century = Math.floor(d.magnitude / 100) + 1;
	const ord =
		century % 10 === 1 && century % 100 !== 11
			? "st"
			: century % 10 === 2 && century % 100 !== 12
			? "nd"
			: century % 10 === 3 && century % 100 !== 13
			? "rd"
			: "th";
	return `${century}${ord} c.${suffix || " AD"}`;
}

// Truncate a year tag to a coarser bucket (for "same decade / century" search).
// Works on digits rather than segments so non-canonical spellings (e.g.
// `#ad/1912` or `#ad/19/12`) still land in the right bucket.
export function truncateTag(tag: string, level: Precision): string | null {
	const m = TAG_RE.exec(tag.trim());
	if (!m) return null;
	const era = m[1];
	const digits = m[2].replace(/\//g, "");
	const keep = level === "century" ? 2 : level === "decade" ? 3 : 4;
	if (digits.length < keep) return null;
	const kept = digits.slice(0, keep);
	const parts = [kept.slice(0, 2), ...kept.slice(2).split("")];
	return `#${era}/${parts.join("/")}`;
}
