// Minimal query language mirroring Tag Search Pro:
//   term1 term2     -> AND
//   term1 OR term2  -> OR across groups
//   -term           -> NOT
//   "exact phrase"  -> phrase (not split further)
//   file:#tag       -> source file carries the tag (frontmatter or body;
//                      nested tags count: file:#history hits #history/rome)
//   path:folder/    -> source file path contains the text

import { normalizeTag } from "./db-gate";

type TermField = "text" | "filetag" | "path";

interface ParsedTerm {
	text: string;
	negated: boolean;
	field: TermField;
}

interface ParsedGroup {
	terms: ParsedTerm[];
}

export interface ParsedQuery {
	groups: ParsedGroup[];
}

// Where a block comes from, for file-level terms. Both are optional so
// haystack-only callers can skip them (file terms then never match).
export interface QueryContext {
	fileTags?: readonly string[];
	filePath?: string;
}

export function tokenise(raw: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < raw.length) {
		if (/\s/.test(raw[i])) {
			i++;
			continue;
		}
		if (raw[i] === '"') {
			const end = raw.indexOf('"', i + 1);
			if (end === -1) {
				tokens.push(raw.substring(i));
				break;
			}
			tokens.push(raw.substring(i, end + 1));
			i = end + 1;
		} else {
			let j = i + 1;
			while (j < raw.length && !/\s/.test(raw[j])) j++;
			tokens.push(raw.substring(i, j));
			i = j;
		}
	}
	return tokens;
}

export function parseQuery(query: string): ParsedQuery {
	const groups: ParsedGroup[] = [];
	for (const part of query.split(/\bOR\b/)) {
		const terms: ParsedTerm[] = [];
		for (const tok of tokenise(part.trim())) {
			if (!tok) continue;
			let text = tok;
			let negated = false;
			if (text.startsWith("-") && text.length > 1) {
				negated = true;
				text = text.substring(1);
			}
			let field: TermField = "text";
			if (/^file:/i.test(text)) {
				field = "filetag";
				text = text.substring(5);
			} else if (/^path:/i.test(text)) {
				field = "path";
				text = text.substring(5);
			}
			if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
				text = text.slice(1, -1);
			}
			text = text.toLowerCase().trim();
			if (field === "filetag") text = normalizeTag(text);
			if (text) terms.push({ text, negated, field });
		}
		if (terms.length) groups.push({ terms });
	}
	return { groups };
}

function termMatches(
	t: ParsedTerm,
	haystackLower: string,
	ctx?: QueryContext
): boolean {
	if (t.field === "filetag") {
		const tags = ctx?.fileTags ?? [];
		return tags.some((raw) => {
			const tag = normalizeTag(raw);
			return tag === t.text || tag.startsWith(`${t.text}/`);
		});
	}
	if (t.field === "path")
		return (ctx?.filePath ?? "").toLowerCase().includes(t.text);
	return haystackLower.includes(t.text);
}

// A haystack matches if ANY OR-group matches; a group matches if ALL its
// terms match (respecting NOT). File-level terms consult `ctx` instead of
// the haystack.
export function matchesQuery(
	haystackLower: string,
	pq: ParsedQuery,
	ctx?: QueryContext
): boolean {
	if (pq.groups.length === 0) return true;
	return pq.groups.some((g) =>
		g.terms.every((t) => {
			const has = termMatches(t, haystackLower, ctx);
			return t.negated ? !has : has;
		})
	);
}
