import { MarkdownRenderer, Notice, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { dbMarkersToHtml } from "./db-marker";
import { langRank } from "./db-format";
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
	sourcePath = "",
	mask = false
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
			wireDbRef(plugin, el, id, { mask });
		}
	});
}

// Attach the click / context-menu behaviour of a rendered entity reference.
// Normal mode: left-click opens the editor modal, right-click the standard
// menu. Mask mode (immersive recall): the text starts hidden, left-click
// flips hidden/revealed, and while hidden the right-click menu only offers
// the entity's language variants to reveal with.
export function wireDbRef(
	plugin: HistoryLoggingPlugin,
	el: HTMLElement,
	id: string,
	opts: {
		mask?: boolean;
		onSaved?: () => void;
		onUnannotate?: () => void;
	} = {}
): void {
	if (opts.mask) {
		el.addClass("hl-db-mask");
		el.setAttr("aria-label", "点击揭开");
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			const hidden = el.hasClass("hl-db-mask");
			el.toggleClass("hl-db-mask", !hidden);
			el.setAttr("aria-label", hidden ? "点击遮住" : "点击揭开");
		});
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (el.hasClass("hl-db-mask")) openDbLangMenu(plugin, el, id, e);
			else openDbRefMenu(plugin, id, e, opts.onUnannotate);
		});
		return;
	}
	el.setAttr("aria-label", "Edit entity");
	el.addEventListener("click", (e) => {
		e.stopPropagation();
		openDbEntityEditor(plugin, id, opts.onSaved);
	});
	el.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		e.stopPropagation();
		openDbRefMenu(plugin, id, e, opts.onUnannotate);
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

function makeDbPop(e: MouseEvent): {
	mk: (icon: string, label: string) => HTMLDivElement;
	close: () => void;
} {
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
	return { mk, close };
}

// Right-click menu on an entity reference inside rendered quiz text:
// 编辑词条 / 打开词条页 / 复制词条 ID (no 取消标注 — the quiz keeps its
// own copy of the marker, so unannotating here would be ambiguous).
export function openDbRefMenu(
	plugin: HistoryLoggingPlugin,
	id: string,
	e: MouseEvent,
	onUnannotate?: () => void
): void {
	const { mk, close } = makeDbPop(e);
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
	if (onUnannotate)
		mk("⊘", "取消标注").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			close();
			onUnannotate();
		});
	mk("⧉", "复制词条 ID").addEventListener("mousedown", (ev) => {
		ev.preventDefault();
		close();
		void navigator.clipboard?.writeText(id);
		new Notice(`已复制词条 ID：${id}`);
	});
}

// Mask-mode right-click: a standalone menu listing the configured display
// languages. A language with an alias is clickable — picking it reveals the
// reference with that spelling (and plays its audio if one exists). A language
// the entity has no alias for is shown greyed out and disabled.
export function openDbLangMenu(
	plugin: HistoryLoggingPlugin,
	el: HTMLElement,
	id: string,
	e: MouseEvent
): void {
	void (async () => {
		const entity = (await plugin.store.readEntities()).get(id);
		if (!entity) {
			new Notice("找不到这个词条。");
			return;
		}
		// Configured languages first (in order), then any extra languages the
		// entity actually has, so no existing alias is ever hidden.
		const langs: string[] = [];
		for (const lang of plugin.settings.entityLangs)
			if (!langs.includes(lang)) langs.push(lang);
		for (const label of entity.labels)
			if (!langs.includes(label.lang)) langs.push(label.lang);
		langs.sort((a, b) => langRank(a) - langRank(b));

		const { mk, close } = makeDbPop(e);
		for (const lang of langs) {
			const label = entity.labels.find((x) => x.lang === lang && x.text);
			const audio = entity.audios.find((x) => x.lang === lang);
			// Show only the language, never the alias text — printing the word
			// here would spoil the very answer the mask is hiding.
			const row = mk(lang, langDisplayName(lang));
			if (!label) {
				row.addClass("hl-le-pop-item-disabled");
				continue;
			}
			if (audio) row.createSpan({ cls: "hl-le-pop-audio", text: "🔊" });
			row.addEventListener("mousedown", (ev) => {
				ev.preventDefault();
				close();
				el.setText(label.text);
				// Remaining same-language spellings trail in faint text, so
				// a correct recall of an alias is not mistaken for an error.
				const others = entity.labels
					.filter(
						(x) =>
							x.lang === lang &&
							x.text &&
							x.text !== label.text
					)
					.map((x) => x.text);
				if (others.length)
					el.createSpan({
						cls: "hl-db-aliases",
						text: ` ⸱ ${others.join(" ⸱ ")}`,
					});
				el.removeClass("hl-db-mask");
				el.setAttr("aria-label", "点击遮住");
				if (audio) playEntityAudio(plugin, audio.link);
			});
		}
	})();
}

// Name a language by its own endonym (中文 / 日本語 / 한국어 / Français …) so
// the mask menu labels languages without revealing the hidden alias. Endonyms
// written in non-Latin, non-CJK scripts (Greek, Cyrillic, Arabic …) fall back
// to the Latin-script English name (Greek, Russian …); unknown codes show the
// raw code. Uses the built-in Intl catalogue, so new languages need no table.
const LATIN_OR_CJK =
	/^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{White_Space}\p{P}\p{M}]+$/u;

function intlLanguageName(code: string, inLocale: string): string | undefined {
	try {
		const name = new Intl.DisplayNames([inLocale], {
			type: "language",
		}).of(code);
		if (!name || name.toLowerCase() === code.toLowerCase()) return undefined;
		return name;
	} catch {
		return undefined;
	}
}

export function langDisplayName(lang: string): string {
	const endonym = intlLanguageName(lang, lang);
	if (endonym && LATIN_OR_CJK.test(endonym))
		return endonym[0].toUpperCase() + endonym.slice(1);
	const english = intlLanguageName(lang, "en");
	if (english) return english;
	return endonym ?? lang;
}

// Play a vault audio attachment referenced as `[[file.mp3]]` (optional
// `|alias` display text is ignored).
export function playEntityAudio(
	plugin: HistoryLoggingPlugin,
	link: string
): void {
	const path = link.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
	const file = plugin.app.metadataCache.getFirstLinkpathDest(path, "");
	if (!(file instanceof TFile)) {
		new Notice(`找不到音频附件：${link}`);
		return;
	}
	void new Audio(plugin.app.vault.getResourcePath(file)).play();
}
