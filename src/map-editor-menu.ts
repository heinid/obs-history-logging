// Manual map entry point: right-clicking in the editor on a line with an
// image embed offers "联入为历史地图". Any `{ev …}` markers in the
// surrounding block prefill the linked events.

import { Editor, MarkdownFileInfo, MarkdownView, Menu } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { imageEmbeds } from "./map-candidates";
import { MapModal, newMapEntry } from "./map-modal";
import { blockAt } from "./scan";
import { parseEvMarks } from "./parser";

export function registerMapEditorMenu(plugin: HistoryLoggingPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on(
			"editor-menu",
			(
				menu: Menu,
				editor: Editor,
				info: MarkdownView | MarkdownFileInfo
			) => {
				if (!info.file) return;
				const line = editor.getLine(editor.getCursor().line);
				const images = imageEmbeds(line);
				if (!images.length) return;
				const content = editor.getValue().replace(/\r\n/g, "\n");
				const offset = editor.posToOffset(editor.getCursor());
				const block = blockAt(content, offset).text;
				const marks = parseEvMarks(block);
				for (const link of images) {
					menu.addItem((item) =>
						item
							.setTitle(
								images.length > 1
									? `联入为历史地图：${link}`
									: "联入为历史地图"
							)
							.setIcon("map")
							.onClick(() =>
								void openManualMapLink(
									plugin,
									link,
									marks.map((m) => m.id)
								)
							)
					);
				}
			}
		)
	);
}

async function openManualMapLink(
	plugin: HistoryLoggingPlugin,
	link: string,
	events: string[]
): Promise<void> {
	const maps = await plugin.store.readMaps();
	const resolve = (l: string): string =>
		plugin.app.metadataCache.getFirstLinkpathDest(l, "")?.path ?? l;
	const path = resolve(link);
	const existing = [...maps.values()].find(
		(m) => resolve(m.image) === path
	);
	if (existing) {
		const entry = { ...existing };
		for (const ev of events)
			if (!entry.events.includes(ev))
				entry.events = [...entry.events, ev];
		new MapModal(plugin.app, plugin, entry, false).open();
		return;
	}
	const file = plugin.app.metadataCache.getFirstLinkpathDest(link, "");
	const entry = newMapEntry((id) => maps.has(id), {
		title: "",
		image: file?.path ?? link,
		events,
	});
	new MapModal(plugin.app, plugin, entry, true).open();
}
