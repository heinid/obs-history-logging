import { MarkdownRenderer } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { dbMarkersToHtml } from "./db-marker";

// Entity id → entity-type color, for the `{db …}` underlines in quiz text.
export type DbColors = Map<string, string>;

export async function loadDbColors(
	plugin: HistoryLoggingPlugin
): Promise<DbColors> {
	const [entities, types] = await Promise.all([
		plugin.store.readEntities(),
		plugin.store.readDbTypes(),
	]);
	const colorOf = new Map(types.map((t) => [t.name, t.color]));
	return new Map(
		[...entities.values()].map((e) => [e.id, colorOf.get(e.type) ?? ""])
	);
}

// Render quiz markdown with `{db …}` markers folded into clickable,
// type-colored entity references (unknown ids fall back to plain text).
export function renderQuizText(
	plugin: HistoryLoggingPlugin,
	text: string,
	host: HTMLElement,
	colors: DbColors,
	sourcePath = ""
): void {
	void MarkdownRenderer.render(
		plugin.app,
		dbMarkersToHtml(text, (id) => colors.get(id) ?? null),
		host,
		sourcePath,
		plugin
	).then(() => {
		for (const el of Array.from(
			host.querySelectorAll<HTMLElement>("span.hl-db-ref")
		)) {
			const id = el.getAttr("data-db-id");
			if (!id) continue;
			el.setAttr("aria-label", "Open entity");
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				void plugin.openEntity(id);
			});
		}
	});
}
