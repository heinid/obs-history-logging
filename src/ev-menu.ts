// The ⌛ click menu: instead of jumping straight into the summary modal,
// clicking an event marker opens a native menu — summary, the Wikipedia
// year page for the event's year, a jump to the event on the timeline, and
// any user-defined URL actions from the settings.

import { Menu, Notice } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { parseYearTag } from "./year-tag";
import {
	fillActionUrl,
	wikipediaYearTitle,
	wikipediaYearUrl,
} from "./ev-actions";

export function openEvMenu(
	plugin: HistoryLoggingPlugin,
	evt: MouseEvent,
	id: string,
	tag: string,
	tracks: string[] = []
): void {
	const decoded = parseYearTag(tag);
	const menu = new Menu();

	menu.addItem((item) =>
		item
			.setTitle("View / edit summary")
			.setIcon("pencil")
			.onClick(() => plugin.openSummary(id, tag))
	);

	if (decoded) {
		const lang = plugin.settings.wikiLang;
		menu.addItem((item) =>
			item
				.setTitle(
					`Open Wikipedia (${lang}): ${wikipediaYearTitle(lang, decoded)}`
				)
				.setIcon("globe")
				.onClick(() => window.open(wikipediaYearUrl(lang, decoded)))
		);
		menu.addItem((item) =>
			item
				.setTitle("Show on timeline")
				.setIcon("history")
				.onClick(() => void plugin.revealOnTimeline(id, tag))
		);
	}

	const actions = plugin.settings.evActions.filter(
		(a) => a.name && a.url
	);
	if (decoded && actions.length) {
		menu.addSeparator();
		for (const action of actions) {
			menu.addItem((item) =>
				item
					.setTitle(action.name)
					.setIcon("external-link")
					.onClick(() => {
						const url = fillActionUrl(
							action.url,
							decoded,
							tag,
							tracks[0] ?? ""
						);
						if (/^https?:\/\//.test(url)) window.open(url);
						else new Notice("Action URL must start with http(s)://");
					})
			);
		}
	}

	menu.showAtMouseEvent(evt);
}
