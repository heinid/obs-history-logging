// The ⌛ click menu: instead of jumping straight into the summary modal,
// clicking an event marker opens a native menu — summary, the Wikipedia
// year page for the event's year, a jump to the event on the timeline, and
// any user-defined URL actions from the settings.

import { Menu, Notice } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { parseYearTag } from "./year-tag";
import { addEventForTag } from "./commands";
import {
	fillActionUrl,
	wikipediaYearTitle,
	wikipediaYearUrl,
} from "./ev-actions";

// Source location of a bare (not yet `{ev …}`-wrapped) year tag; lets the
// menu offer summary editing with deferred event creation.
export interface BareTagSource {
	filePath: string;
	offset: number;
}

export function openEvMenu(
	plugin: HistoryLoggingPlugin,
	evt: MouseEvent,
	id: string,
	tag: string,
	tracks: string[] = [],
	bare?: BareTagSource
): void {
	void openEvMenuAsync(plugin, evt, id, tag, tracks, bare);
}

async function openEvMenuAsync(
	plugin: HistoryLoggingPlugin,
	evt: MouseEvent,
	id: string,
	tag: string,
	tracks: string[],
	bare?: BareTagSource
): Promise<void> {
	const decoded = parseYearTag(tag);
	const layouts = decoded ? await plugin.store.readLayouts() : [];
	const menu = new Menu();

	if (id)
		menu.addItem((item) =>
			item
				.setTitle("View / edit summary")
				.setIcon("pencil")
				.onClick(() => plugin.openSummary(id, tag))
		);
	else if (bare)
		menu.addItem((item) =>
			item
				.setTitle("Add summary")
				.setIcon("pencil")
				.onClick(() =>
					void addEventForTag(plugin, bare.filePath, bare.offset, tag)
				)
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
		if (layouts.length)
			menu.addItem((item) => {
				item.setTitle("以布局显示…").setIcon("layout-grid");
				// setSubmenu is public API since Obsidian 1.4 but missing
				// from the bundled typings; reach it structurally.
				const sub = (
					item as unknown as { setSubmenu(): Menu }
				).setSubmenu();
				for (const layout of layouts)
					sub.addItem((si) =>
						si
							.setTitle(layout.name)
							.setIcon("gantt-chart")
							.onClick(() =>
								void plugin.revealOnLayout(layout, id, tag)
							)
					);
			});
	}

	const search = globalSearch(plugin);
	if (search)
		menu.addItem((item) =>
			item
				.setTitle("Search tag")
				.setIcon("search")
				.onClick(() => search.openGlobalSearch(`tag:${tag}`))
		);

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

// Obsidian's core global-search plugin has no public typings; reach it
// through a narrow structural cast.
function globalSearch(
	plugin: HistoryLoggingPlugin
): { openGlobalSearch(query: string): void } | null {
	const app = plugin.app as unknown as {
		internalPlugins?: {
			getEnabledPluginById?(
				id: string
			): { openGlobalSearch(query: string): void } | null;
		};
	};
	return app.internalPlugins?.getEnabledPluginById?.("global-search") ?? null;
}
