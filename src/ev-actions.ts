// Pure (Obsidian-free) helpers behind the ⌛ click menu: Wikipedia year-page
// URLs and user-defined URL action templates.

import { DecodedYear } from "./types";

export interface EvAction {
	name: string;
	// URL template with `{year}` (signed number, BC negative), `{tag}` and
	// `{track}` (first bound track, may be empty) placeholders.
	url: string;
}

// Title of the year page per Wikipedia language edition.
export function wikipediaYearTitle(lang: string, d: DecodedYear): string {
	const y = d.magnitude;
	if (lang === "ja") return d.era === "bc" ? `紀元前${y}年` : `${y}年`;
	if (lang === "zh") return d.era === "bc" ? `前${y}年` : `${y}年`;
	return d.era === "bc" ? `${y} BC` : `${y}`;
}

export function wikipediaYearUrl(lang: string, d: DecodedYear): string {
	const title = wikipediaYearTitle(lang, d).replace(/ /g, "_");
	return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
}

export function fillActionUrl(
	template: string,
	d: DecodedYear,
	tag: string,
	track: string
): string {
	const year = d.era === "bc" ? `-${d.magnitude}` : `${d.magnitude}`;
	return template
		.replace(/\{year\}/g, encodeURIComponent(year))
		.replace(/\{tag\}/g, encodeURIComponent(tag))
		.replace(/\{track\}/g, encodeURIComponent(track));
}
