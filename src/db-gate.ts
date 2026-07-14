// Tag gate for vault-wide entity features: `{db …}` rendering, completion
// and interactions only activate in notes carrying one of the configured
// tags. Pure helpers so the gate is testable outside Obsidian.

// Canonical form of a tag for comparison: no leading `#`, lower-cased.
export function normalizeTag(tag: string): string {
	return tag.replace(/^#+/, "").trim().toLowerCase();
}

// Whether a note's tags (any form) hit one of the enabling tags. Nested
// tags count: enabling `history` also matches `history/rome`.
export function hasDbTag(
	noteTags: readonly string[],
	enableTags: readonly string[]
): boolean {
	const enabled = enableTags.map(normalizeTag).filter((t) => t.length > 0);
	if (!enabled.length) return false;
	return noteTags.some((raw) => {
		const t = normalizeTag(raw);
		return enabled.some((e) => t === e || t.startsWith(`${e}/`));
	});
}
