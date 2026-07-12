import { MarkdownRenderer, Notice } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { dbMarkersToHtml } from "./db-marker";
import { EntityModal } from "./entity-modal";

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
			el.setAttr("aria-label", "Edit entity");
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				openDbEntityEditor(plugin, id);
			});
			el.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				openDbRefMenu(plugin, id, e);
			});
		}
	});
}

// Left-click / "编辑词条": open the entity editor modal in place; every
// open quiz modal refreshes after a save.
export function openDbEntityEditor(
	plugin: HistoryLoggingPlugin,
	id: string,
	onSaved?: () => void
): void {
	void (async () => {
		const entity = (await plugin.store.readEntities()).get(id);
		if (!entity) {
			new Notice("找不到这个词条。");
			return;
		}
		new EntityModal(plugin.app, plugin, entity, false, () => {
			plugin.modalStash.refreshOpen();
			onSaved?.();
		}).open();
	})();
}

// Right-click menu on an entity reference inside rendered quiz text:
// 编辑词条 / 打开词条页 / 复制词条 ID (no 取消标注 — the quiz keeps its
// own copy of the marker, so unannotating here would be ambiguous).
function openDbRefMenu(
	plugin: HistoryLoggingPlugin,
	id: string,
	e: MouseEvent
): void {
	const pop = (
		((e.target as HTMLElement).closest(
			".modal-container"
		) as HTMLElement | null) ?? document.body
	).createDiv({ cls: "hl-le-pop" });
	pop.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - 320))}px`;
	pop.style.top = `${Math.max(8, Math.min(e.clientY + 4, window.innerHeight - 40))}px`;
	const close = (): void => {
		pop.remove();
		document.removeEventListener("mousedown", onDown, true);
		document.removeEventListener("keydown", onKey, true);
	};
	const onDown = (ev: MouseEvent): void => {
		if (!pop.contains(ev.target as Node)) close();
	};
	const onKey = (ev: KeyboardEvent): void => {
		if (ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			close();
		}
	};
	document.addEventListener("mousedown", onDown, true);
	document.addEventListener("keydown", onKey, true);

	const mk = (icon: string, label: string): HTMLDivElement => {
		const row = pop.createDiv({ cls: "hl-le-pop-item" });
		row.createSpan({ cls: "hl-le-pop-icon", text: icon });
		row.createSpan({ cls: "hl-le-pop-label", text: label });
		return row;
	};
	mk("✎", "编辑词条").addEventListener("mousedown", (ev) => {
		ev.preventDefault();
		close();
		openDbEntityEditor(plugin, id);
	});
	mk("↗", "打开词条页").addEventListener("mousedown", (ev) => {
		ev.preventDefault();
		close();
		plugin.modalStash.jump(() => plugin.openEntityView(id));
	});
	mk("⧉", "复制词条 ID").addEventListener("mousedown", (ev) => {
		ev.preventDefault();
		close();
		void navigator.clipboard?.writeText(id);
		new Notice(`已复制词条 ID：${id}`);
	});
}
