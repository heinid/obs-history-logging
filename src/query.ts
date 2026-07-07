// Minimal query language mirroring Tag Search Pro:
//   term1 term2     -> AND
//   term1 OR term2  -> OR across groups
//   -term           -> NOT
//   "exact phrase"  -> phrase (not split further)

interface ParsedTerm {
	text: string;
	negated: boolean;
}

interface ParsedGroup {
	terms: ParsedTerm[];
}

export interface ParsedQuery {
	groups: ParsedGroup[];
}

function tokenise(raw: string): string[] {
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
			if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
				text = text.slice(1, -1);
			}
			text = text.toLowerCase().trim();
			if (text) terms.push({ text, negated });
		}
		if (terms.length) groups.push({ terms });
	}
	return { groups };
}

// A haystack matches if ANY OR-group matches; a group matches if ALL its
// terms match (respecting NOT).
export function matchesQuery(haystackLower: string, pq: ParsedQuery): boolean {
	if (pq.groups.length === 0) return true;
	return pq.groups.some((g) =>
		g.terms.every((t) => {
			const has = haystackLower.includes(t.text);
			return t.negated ? !has : has;
		})
	);
}
