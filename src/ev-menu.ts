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
	const views = plugin.settings.evMenuViews;
	const layouts =
		decoded && views.some((v) => v.kind === "layout")
			? await plugin.store.readLayouts()
			: [];
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
		if (views.length)
			menu.addItem((item) => {
				item.setTitle("Show on timeline with…").setIcon("layout-grid");
				// setSubmenu is public API since Obsidian 1.4 but missing
				// from the bundled typings; reach it structurally.
				const sub = (
					item as unknown as { setSubmenu(): Menu }
				).setSubmenu();
				for (const v of views) {
					// A profile entry is a single-track layout on the fly; a
					// layout entry is looked up in layouts.md by name.
					const layout =
						v.kind === "profile"
							? {
									name: v.name,
									panes: [
										{
											filter: "",
											lens: "",
											groupBy: "century",
											profile: v.name,
										},
									],
							  }
							: layouts.find((l) => l.name === v.name);
					sub.addItem((si) => {
						si.setTitle(v.name).setIcon(
							v.kind === "profile" ? "list" : "gantt-chart"
						);
						if (layout)
							si.onClick(() =>
								void plugin.revealOnLayout(layout, id, tag)
							);
						else
							si.setDisabled(true);
					});
				}
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
