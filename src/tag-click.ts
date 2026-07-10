// Left-clicking a `#ad/…` / `#bc/…` year tag in a note opens the plugin's
// event menu instead of Obsidian's default tag search (which stays reachable
// through the menu's "Search tag" item and modifier-clicks). Ordinary tags
// keep their default behaviour. Also adds the same actions to the editor's
// native right-click menu.

import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { Editor, MarkdownFileInfo, MarkdownView, Menu } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { tagAtCursor, addEventForTag } from "./commands";
import { openEvMenu, BareTagSource } from "./ev-menu";

const EV_BEFORE_RE = /\{ev\s+([0-9a-z]{8})\s+$/;

// Year tag + wrapping state at a (line text, column) position.
function hitAt(
	lineText: string,
	ch: number
): { tag: string; from: number; evId: string | null } | null {
	const hit = tagAtCursor(lineText, ch);
	if (!hit) return null;
	const idm = EV_BEFORE_RE.exec(lineText.slice(0, hit.from));
	return { tag: hit.tag, from: hit.from, evId: idm ? idm[1] : null };
}

export function createTagClickExtension(plugin: HistoryLoggingPlugin) {
	return Prec.highest(
		EditorView.domEventHandlers({
			click: (e, view) => {
				if (e.button !== 0) return false;
				if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)
					return false;
				const target = e.target;
				if (
					!(target instanceof HTMLElement) ||
					!target.closest(".cm-hashtag")
				)
					return false;
				const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
				if (pos === null) return false;
				const line = view.state.doc.lineAt(pos);
				const hit = hitAt(line.text, pos - line.from);
				if (!hit) return false;
				e.preventDefault();
				e.stopPropagation();
				const file = plugin.app.workspace.getActiveFile();
				const bare: BareTagSource | undefined =
					!hit.evId && file
						? { filePath: file.path, offset: line.from + hit.from }
						: undefined;
				openEvMenu(plugin, e, hit.evId ?? "", hit.tag, [], bare);
				return true;
			},
		})
	);
}

export function registerTagContextMenu(plugin: HistoryLoggingPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on(
			"editor-menu",
			(menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				const cursor = editor.getCursor();
				const hit = hitAt(editor.getLine(cursor.line), cursor.ch);
				if (!hit) return;
				const file = info.file;
				menu.addItem((item) =>
					item
						.setTitle("Show on timeline")
						.setIcon("history")
						.onClick(() =>
							void plugin.revealOnTimeline(hit.evId ?? "", hit.tag)
						)
				);
				if (hit.evId) {
					const evId = hit.evId;
					menu.addItem((item) =>
						item
							.setTitle("View / edit summary")
							.setIcon("pencil")
							.onClick(() => plugin.openSummary(evId, hit.tag))
					);
				} else if (file) {
					const offset = editor.posToOffset({
						line: cursor.line,
						ch: hit.from,
					});
					menu.addItem((item) =>
						item
							.setTitle("Add summary")
							.setIcon("pencil")
							.onClick(() =>
								void addEventForTag(
									plugin,
									file.path,
									offset,
									hit.tag
								)
							)
					);
				}
			}
		)
	);
}
