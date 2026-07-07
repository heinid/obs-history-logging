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
			const next = a.nextSibling;
			if (!prev || prev.nodeType !== Node.TEXT_NODE) continue;
			if (!next || next.nodeType !== Node.TEXT_NODE) continue;

			const prevText = prev.textContent ?? "";
			const nextText = next.textContent ?? "";
			const open = OPEN_RE.exec(prevText);
			if (!open || !CLOSE_RE.test(nextText)) continue;

			const id = open[1];
			prev.textContent = prevText.slice(0, open.index);
			next.textContent = nextText.replace(CLOSE_RE, "");

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
