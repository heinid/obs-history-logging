import {
	EditorView,
	ViewPlugin,
	ViewUpdate,
	Decoration,
	DecorationSet,
	WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type HistoryLoggingPlugin from "./main";
import { evRegex } from "./parser";
import { tracksIn } from "./tracks";
import { EV_SYMBOL } from "./constants";
import { openEvMenu } from "./ev-menu";

// The clickable ⌛ marker shown in place of the `{ev ... }` closing syntax.
class EvSymbolWidget extends WidgetType {
	constructor(
		private plugin: HistoryLoggingPlugin,
		private id: string,
		private tag: string,
		private tracks: string[]
	) {
		super();
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = "hl-ev-symbol";
		span.textContent = EV_SYMBOL;
		span.setAttribute("aria-label", "Event actions");
		span.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			openEvMenu(this.plugin, e, this.id, this.tag, this.tracks);
		});
		return span;
	}

	eq(other: EvSymbolWidget): boolean {
		return other.id === this.id && other.tag === this.tag;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

function buildDecorations(
	view: EditorView,
	plugin: HistoryLoggingPlugin
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const sel = view.state.selection.ranges;

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		const re = evRegex();
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const matchStart = from + m.index;
			const matchEnd = matchStart + m[0].length;
			const id = m[1];
			const tag = m[2];
			const tracks = tracksIn(m[3] ?? "");
			const tagStart = matchStart + m[0].indexOf(tag);
			const tagEnd = tagStart + tag.length;

			// Keep the raw text editable while the cursor/selection is inside.
			const cursorInside = sel.some(
				(r) => r.from <= matchEnd && r.to >= matchStart
			);
			if (cursorInside) continue;

			// Hide `{ev <id> ` before the tag.
			builder.add(matchStart, tagStart, Decoration.replace({}));
			// Replace ` }` after the tag with the clickable ⌛ symbol.
			builder.add(
				tagEnd,
				matchEnd,
				Decoration.replace({
					widget: new EvSymbolWidget(plugin, id, tag, tracks),
				})
			);
		}
	}

	return builder.finish();
}

export function createLivePreviewExtension(plugin: HistoryLoggingPlugin) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, plugin);
			}
			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.selectionSet
				) {
					this.decorations = buildDecorations(update.view, plugin);
				}
			}
		},
		{ decorations: (v) => v.decorations }
	);
}
