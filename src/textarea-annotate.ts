import { Notice, prepareFuzzySearch } from "obsidian";
import { EntityEntry, displayName } from "./db-format";
import { entitySearchText, makeDbMarker } from "./db-marker";
import { entityHint } from "./live-editor";

export interface AnnotateMenuOptions {
	entities(): EntityEntry[];
	typeColor(name: string): string | null;
	// Opens the entity creation modal; `apply` is called with the saved entry.
	onCreate(word: string, apply: (ent: EntityEntry) => void): void;
}

// Right-click entity annotation for plain textareas (the quiz editor):
// select text → 新建词条 / 链接到已有词条, replacing the selection with a
// `{db id text}` marker. No autocomplete — just the menu.
export function attachAnnotateMenu(
	area: HTMLTextAreaElement,
	opts: AnnotateMenuOptions
): void {
	area.addEventListener("contextmenu", (e) => {
		const rawFrom = area.selectionStart;
		const rawTo = area.selectionEnd;
		if (rawFrom >= rawTo) return;
		const raw = area.value.slice(rawFrom, rawTo);
		const word = raw.trim();
		// Selections that span lines or touch marker syntax keep the native menu.
		if (!word || /[{}\n]/.test(word)) return;
		const from = rawFrom + (raw.length - raw.trimStart().length);
		const to = rawTo - (raw.length - raw.trimEnd().length);
		e.preventDefault();
		openMenu(area, opts, e, from, to, word);
	});
}

function overlayParent(area: HTMLTextAreaElement): HTMLElement {
	return (
		(area.closest(".modal-container") as HTMLElement | null) ??
		document.body
	);
}

function openMenu(
	area: HTMLTextAreaElement,
	opts: AnnotateMenuOptions,
	e: MouseEvent,
	from: number,
	to: number,
	word: string
): void {
	const pop = overlayParent(area).createDiv({ cls: "hl-le-pop" });
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

	const apply = (ent: EntityEntry): void => {
		area.value = `${area.value.slice(0, from)}${makeDbMarker(
			ent.id,
			word
		)}${area.value.slice(to)}`;
		area.dispatchEvent(new Event("input"));
		new Notice(`已标注「${word}」→ ${displayName(ent)}`);
	};

	const mk = (icon: string, label: string, hint: string): HTMLDivElement => {
		const row = pop.createDiv({ cls: "hl-le-pop-item" });
		row.createSpan({ cls: "hl-le-pop-icon", text: icon });
		row.createSpan({ cls: "hl-le-pop-label", text: label });
		if (hint) row.createSpan({ cls: "hl-le-suggest-meta", text: hint });
		return row;
	};

	// Entities whose label/alias matches the selection get a one-click row.
	const lower = word.toLowerCase();
	const matches = opts
		.entities()
		.map((ent) => ({
			ent,
			exact: ent.labels.some((l) => l.text.toLowerCase() === lower),
			partial: ent.labels.some((l) => {
				const t = l.text.toLowerCase();
				return t.includes(lower) || lower.includes(t);
			}),
		}))
		.filter((r) => r.exact || r.partial)
		.sort((a, b) => Number(b.exact) - Number(a.exact))
		.slice(0, 3);
	for (const { ent } of matches) {
		const row = mk("⇢", `链接到 ${displayName(ent)}`, ent.type || "");
		const color = opts.typeColor(ent.type);
		if (color) {
			const meta = row.querySelector(".hl-le-suggest-meta");
			(meta as HTMLElement | null)?.style.setProperty("color", color);
		}
		const hint = entityHint(ent, displayName(ent));
		if (hint) row.createSpan({ cls: "hl-le-suggest-meta", text: hint });
		row.addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			close();
			apply(ent);
		});
	}
	mk("＋", "新建词条", `“${word}”`).addEventListener("mousedown", (ev) => {
		ev.preventDefault();
		close();
		opts.onCreate(word, apply);
	});
	mk("⧉", "链接到已有词条…", "").addEventListener("mousedown", (ev) => {
		ev.preventDefault();
		openPicker(pop, opts, word, apply, close);
	});
}

// Inline fuzzy picker over every entity, replacing the menu's rows in place.
function openPicker(
	pop: HTMLDivElement,
	opts: AnnotateMenuOptions,
	word: string,
	apply: (ent: EntityEntry) => void,
	close: () => void
): void {
	pop.empty();
	pop.addClass("hl-le-linkpick");
	const input = pop.createEl("input", {
		type: "text",
		cls: "hl-le-linkpick-input",
	});
	input.placeholder = "搜索词条…";
	input.value = word;
	const list = pop.createDiv();
	let items: EntityEntry[] = [];
	let selected = 0;
	const confirm = (): void => {
		const ent = items[selected];
		if (!ent) return;
		close();
		apply(ent);
	};
	const render = (): void => {
		const q = input.value.trim();
		const fuzzy = q ? prepareFuzzySearch(q) : null;
		items = opts
			.entities()
			.map((ent) => ({
				ent,
				score: fuzzy ? fuzzy(entitySearchText(ent))?.score : 0,
			}))
			.filter((r) => r.score !== undefined && r.score !== null)
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
			.slice(0, 8)
			.map((r) => r.ent);
		selected = Math.min(selected, Math.max(0, items.length - 1));
		list.empty();
		if (!items.length) {
			list.createDiv({ cls: "hl-le-pop-empty", text: "无匹配词条" });
			return;
		}
		items.forEach((ent, i) => {
			const row = list.createDiv({ cls: "hl-le-suggest-item" });
			if (i === selected) row.addClass("is-selected");
			row.createSpan({ cls: "hl-le-suggest-word", text: displayName(ent) });
			const color = opts.typeColor(ent.type);
			const pill = row.createSpan({
				cls: "hl-le-suggest-type",
				text: ent.type || "?",
			});
			if (color) {
				pill.style.color = color;
				pill.style.borderColor = color;
			}
			const others = ent.labels
				.map((l) => l.text)
				.filter((t) => t !== displayName(ent))
				.slice(0, 3)
				.join(" · ");
			if (others)
				row.createSpan({ cls: "hl-le-suggest-meta", text: others });
			row.addEventListener("mousedown", (ev) => {
				ev.preventDefault();
				selected = i;
				confirm();
			});
		});
	};
	input.addEventListener("input", render);
	input.addEventListener("keydown", (ev) => {
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			ev.preventDefault();
			if (items.length)
				selected =
					(selected + (ev.key === "ArrowDown" ? 1 : -1) + items.length) %
					items.length;
			render();
		} else if (ev.key === "Enter") {
			ev.preventDefault();
			confirm();
		}
	});
	render();
	window.setTimeout(() => input.focus(), 0);
}
