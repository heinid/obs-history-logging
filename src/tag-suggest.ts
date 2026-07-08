import { AbstractInputSuggest, App, getAllTags, prepareFuzzySearch } from "obsidian";

// Fuzzy #tag completion for the filter input, in the style of Obsidian's own
// tag suggester. Kicks in only while the token being typed starts with "#";
// picking a suggestion replaces that token and commits it as a live filter.
const TOKEN_RE = /(^|\s)(#[^\s]*)$/;

export class TagSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, private input: HTMLInputElement) {
		super(app, input);
	}

	private allTags(): string[] {
		const seen = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(f);
			if (!cache) continue;
			for (const t of getAllTags(cache) ?? []) seen.add(t);
		}
		return [...seen];
	}

	protected getSuggestions(query: string): string[] {
		const m = TOKEN_RE.exec(query);
		if (!m) return [];
		const fuzzy = prepareFuzzySearch(m[2].slice(1));
		return this.allTags()
			.map((tag) => ({ tag, hit: fuzzy(tag.slice(1)) }))
			.filter((x) => x.hit !== null)
			.sort((a, b) => (b.hit?.score ?? 0) - (a.hit?.score ?? 0) || a.tag.localeCompare(b.tag))
			.slice(0, 25)
			.map((x) => x.tag);
	}

	renderSuggestion(tag: string, el: HTMLElement): void {
		el.setText(tag);
	}

	selectSuggestion(tag: string): void {
		this.input.value = this.input.value.replace(TOKEN_RE, `$1${tag} `);
		this.input.dispatchEvent(new Event("input"));
		this.close();
		this.input.focus();
	}
}
