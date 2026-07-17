// Alt + mouse wheel over a rendered image embed resizes it. The new size is
// persisted with Obsidian's standard width suffix (`![[img.png|320]]`), so
// every renderer (reading view, other devices) honours it — no private state.

import { MarkdownView } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type HistoryLoggingPlugin from "./main";

import { resizeEmbedIn } from "./map-text";

const MIN_W = 64;
const MAX_W = 1600;
const STEP = 1.1;

function newWidth(img: HTMLImageElement, up: boolean): number {
	const cur = img.clientWidth || img.naturalWidth || 300;
	const next = Math.round(up ? cur * STEP : cur / STEP);
	return Math.max(MIN_W, Math.min(MAX_W, next));
}

// Alt+wheel on image embeds inside ordinary note editors (live preview).
export function registerNoteImageResize(plugin: HistoryLoggingPlugin): void {
	plugin.registerDomEvent(
		document,
		"wheel",
		(e: WheelEvent) => {
			if (!e.altKey) return;
			const img = (e.target as HTMLElement).closest?.("img");
			if (!img) return;
			const embed = img.closest<HTMLElement>(".internal-embed[src]");
			if (!embed) return;
			const view = plugin.app.workspace
				.getLeavesOfType("markdown")
				.map((l) => l.view)
				.find(
					(v): v is MarkdownView =>
						v instanceof MarkdownView &&
						v.containerEl.contains(embed)
				);
			if (!view?.editor) return;
			e.preventDefault();
			e.stopPropagation();
			const link = embed.getAttr("src") ?? "";
			if (!link) return;
			const width = newWidth(img as HTMLImageElement, e.deltaY < 0);
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			let around = 0;
			if (cm) {
				try {
					around = cm.posAtDOM(embed);
				} catch {
					around = 0;
				}
			}
			const doc = view.editor.getValue();
			const result = resizeEmbedIn(doc, link, width, around);
			if (!result) return;
			// Immediate feedback; the editor re-renders the embed right after.
			(img as HTMLImageElement).style.width = `${width}px`;
			view.editor.replaceRange(
				`![[${link}|${width}]]`,
				view.editor.offsetToPos(result.from),
				view.editor.offsetToPos(result.to)
			);
		},
		{ passive: false }
	);
}

// Alt+wheel for images inside a plugin-rendered markdown container whose
// source text the caller owns (entity notes, …). `save` receives the full
// updated source text, debounced.
export function enableContainerImageResize(
	container: HTMLElement,
	getText: () => string,
	save: (text: string) => void
): void {
	let timer: number | null = null;
	let pending: string | null = null;
	container.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			if (!e.altKey) return;
			const img = (e.target as HTMLElement).closest?.("img");
			if (!img) return;
			const embed = img.closest<HTMLElement>(".internal-embed[src]");
			if (!embed) return;
			const link = embed.getAttr("src") ?? "";
			if (!link) return;
			e.preventDefault();
			e.stopPropagation();
			const width = newWidth(img as HTMLImageElement, e.deltaY < 0);
			const result = resizeEmbedIn(pending ?? getText(), link, width);
			if (!result) return;
			(img as HTMLImageElement).style.width = `${width}px`;
			pending = result.text;
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				if (pending !== null) save(pending);
				pending = null;
			}, 600);
		},
		{ passive: false }
	);
}
