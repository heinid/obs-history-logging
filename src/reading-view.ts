import type HistoryLoggingPlugin from "./main";
import { EV_SYMBOL } from "./constants";

const OPEN_RE = /\{ev\s+([0-9a-z]{8})\s+$/;
const CLOSE_RE = /^\s*\}/;

// In reading mode Obsidian renders the inner `#ad/...` as a `.tag` anchor and
// leaves `{ev <id> ` / ` }` as plain text around it. Fold those away and append
// a clickable ⌛ symbol, mirroring the Live Preview treatment.
export function createReadingProcessor(plugin: HistoryLoggingPlugin) {
	return (el: HTMLElement) => {
		const anchors = Array.from(el.querySelectorAll("a.tag"));
		for (const a of anchors) {
			const tag = a.textContent ?? "";
			if (!/^#(ad|bc)(\/\d+)+$/.test(tag)) continue;

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
			prev.textContent = prevText.slice(0, open.index);
			next.textContent = nextText.replace(CLOSE_RE, "");
			for (const n of fold) n.remove();

			const sym = document.createElement("span");
			sym.className = "hl-ev-symbol";
			sym.textContent = EV_SYMBOL;
			sym.setAttribute("aria-label", "Open event summary");
			sym.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				plugin.openSummary(id, tag);
			});
			a.after(sym);
		}
	};
}
