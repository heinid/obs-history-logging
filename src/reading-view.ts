import { MarkdownPostProcessorContext, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EV_SYMBOL } from "./constants";
import { openEvMenu, BareTagSource } from "./ev-menu";
import { yearTagRegex } from "./year-tag";

const OPEN_RE = /\{ev\s+([0-9a-z]{8})\s+$/;
const CLOSE_RE = /^\s*\}/;
const YEAR_ANCHOR_RE = /^#(ad|bc)(\/\d+)+$/;

// In reading mode Obsidian renders the inner `#ad/...` as a `.tag` anchor and
// leaves `{ev <id> ` / ` }` as plain text around it. Fold those away and append
// a clickable ⌛ symbol, mirroring the Live Preview treatment. Year-tag anchors
// (wrapped or bare) also get the plugin's event menu on left click instead of
// Obsidian's default tag search.
export function createReadingProcessor(plugin: HistoryLoggingPlugin) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const anchors = Array.from(
			el.querySelectorAll<HTMLAnchorElement>("a.tag")
		);
		const wrapped = new Map<Element, string>(); // anchor → ev id
		for (const a of anchors) {
			const tag = a.textContent ?? "";
			if (!YEAR_ANCHOR_RE.test(tag)) continue;

			const prev = a.previousSibling;
			if (!prev || prev.nodeType !== Node.TEXT_NODE) continue;

			// Bound `#histolog/<track>` tags render as their own anchors between
			// the year tag and the closing `}` — fold them into the ⌛ too.
			const fold: ChildNode[] = [];
			let next = a.nextSibling;
			while (next) {
				if (next.nodeType === Node.TEXT_NODE) {
					const t = next.textContent ?? "";
					if (CLOSE_RE.test(t)) break;
					if (t.trim() !== "") {
						next = null;
						break;
					}
					fold.push(next as ChildNode);
					next = next.nextSibling;
				} else if (
					next instanceof HTMLElement &&
					next.matches("a.tag") &&
					(next.textContent ?? "").startsWith("#histolog/")
				) {
					fold.push(next as ChildNode);
					next = next.nextSibling;
				} else {
					next = null;
					break;
				}
			}
			if (!next || next.nodeType !== Node.TEXT_NODE) continue;

			const prevText = prev.textContent ?? "";
			const nextText = next.textContent ?? "";
			const open = OPEN_RE.exec(prevText);
			if (!open) continue;

			const id = open[1];
			const tracks = fold
				.filter((n): n is HTMLElement => n instanceof HTMLElement)
				.map((n) => (n.textContent ?? "").replace(/^#histolog\//, ""))
				.filter((t) => t.length > 0);
			prev.textContent = prevText.slice(0, open.index);
			next.textContent = nextText.replace(CLOSE_RE, "");
			for (const n of fold) n.remove();
			wrapped.set(a, id);

			const sym = document.createElement("span");
			sym.className = "hl-ev-symbol";
			sym.textContent = EV_SYMBOL;
			sym.setAttribute("aria-label", "Event actions");
			sym.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				openEvMenu(plugin, e, id, tag, tracks);
			});
			a.after(sym);
		}

		// Left click on a year-tag anchor: our event menu, not tag search.
		const bareSeen = new Map<string, number>(); // tag → bare ordinal
		for (const a of anchors) {
			const tag = a.textContent ?? "";
			if (!YEAR_ANCHOR_RE.test(tag)) continue;
			const id = wrapped.get(a);
			const ordinal = id === undefined ? bareSeen.get(tag) ?? 0 : -1;
			if (id === undefined) bareSeen.set(tag, ordinal + 1);
			a.addEventListener("click", (e) => {
				if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
				e.preventDefault();
				e.stopPropagation();
				if (id !== undefined) {
					openEvMenu(plugin, e, id, tag, []);
					return;
				}
				void (async () => {
					const bare = await resolveBareTag(
						plugin,
						ctx,
						el,
						tag,
						ordinal
					);
					openEvMenu(plugin, e, "", tag, [], bare ?? undefined);
				})();
			});
		}
	};
}

// Locate the source offset of the nth bare occurrence of `tag` within the
// rendered section, so the menu can offer deferred summary creation.
async function resolveBareTag(
	plugin: HistoryLoggingPlugin,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
	tag: string,
	ordinal: number
): Promise<BareTagSource | null> {
	const info = ctx.getSectionInfo(el);
	if (!info) return null;
	const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
	if (!(file instanceof TFile)) return null;
	const content = (await plugin.app.vault.read(file)).replace(/\r\n/g, "\n");
	const lines = content.split("\n");
	if (info.lineEnd >= lines.length) return null;
	const sectionStart = lines.slice(0, info.lineStart).join("\n").length +
		(info.lineStart > 0 ? 1 : 0);
	const section = lines.slice(info.lineStart, info.lineEnd + 1).join("\n");
	const re = yearTagRegex();
	let m: RegExpExecArray | null;
	let seen = 0;
	while ((m = re.exec(section)) !== null) {
		if (m[0] !== tag) continue;
		if (OPEN_RE.test(section.slice(Math.max(0, m.index - 40), m.index)))
			continue;
		if (seen === ordinal)
			return { filePath: file.path, offset: sectionStart + m.index };
		seen++;
	}
	return null;
}
