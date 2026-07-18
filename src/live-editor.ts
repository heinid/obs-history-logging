// A small CodeMirror-based live editor used by the summary / entity modals.
// Renders instead of exposing raw syntax: `{db <id> <word>}` markers fold to
// the word with a type-coloured underline (click opens the entity), and
// `**bold**` renders bold — the raw text reappears when the cursor enters.
// Also hosts the entity completion dropdown and the right-click annotation
// menu, and reports every change for debounced auto-saving.

import {
	EditorView,
	ViewPlugin,
	ViewUpdate,
	Decoration,
	DecorationSet,
	WidgetType,
	keymap,
	placeholder as cmPlaceholder,
} from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Notice, prepareFuzzySearch, Scope } from "obsidian";
import { EntityEntry, displayName } from "./db-format";
import {
	AliasCandidate,
	aliasCandidates,
	queryCandidates,
	triggerQuery,
	dbRegex,
	entitySearchText,
	makeDbMarker,
	parseDbMarks,
	stripDbMarkers,
} from "./db-marker";

// Put an Escape handler in FRONT of a modal's key scope, so it runs before
// the modal's own Escape-to-close handler. `cb` returns true when it consumed
// the key (e.g. it closed the completion dropdown); returning true from the
// scope handler lets the modal's default close run.
export function registerEscapeFirst(scope: Scope, cb: () => boolean): void {
	const handler = scope.register([], "Escape", () => (cb() ? false : true));
	const keys = (scope as unknown as { keys: unknown[] }).keys;
	if (!Array.isArray(keys)) return;
	const i = keys.indexOf(handler);
	if (i > 0) {
		keys.splice(i, 1);
		keys.unshift(handler);
	}
}

export interface LiveEditorOptions {
	value: string;
	placeholder?: string;
	// Called on every document change (caller debounces the actual write).
	onChange?: (value: string) => void;
	// Underline colour for an entity id; null = render as plain text.
	colorFor?: (id: string) => string | null;
	// Left click on a folded entity marker (open the entity editor).
	onOpenEntity?: (id: string) => void;
	// Right-click actions on a folded entity marker.
	onOpenEntityPage?: (id: string) => void;
	// Create a cloze quiz from selected plain text.
	onCreateQuiz?: (selection: string) => void;
	// Internal: wired by LiveEditor to open the folded-marker right-click menu.
	onEntityMenu?: (id: string, word: string, e: MouseEvent) => void;
	// Entity annotation support (completion dropdown + right-click menu).
	annotate?: {
		entities: () => EntityEntry[];
		typeColor: (typeName: string) => string | null;
		// "＋ New entity" flow: open the entity editor, then call apply.
		onCreate: (word: string, apply: (e: EntityEntry) => void) => void;
		// How the completion dropdown fires while typing (`//` always works):
		// "normal" (CJK 1 char / Latin 2), "conservative" (CJK 2 / Latin 3),
		// or "off" (only the explicit `//` trigger). Default "normal".
		autoTrigger?: () => "normal" | "conservative" | "off";
		// Also auto-complete on the last word of a spaced name (surname).
		lastToken?: () => boolean;
	};
}

// Grey disambiguation text for an entity row (same-name entries must be
// tellable apart): other word forms first, then tags, then the first line
// of the notes, and the id as a last resort.
export function entityHint(ent: EntityEntry, shown: string): string {
	const others = ent.labels
		.map((l) => l.text)
		.filter((t) => t && t !== shown)
		.slice(0, 3);
	if (others.length) return others.join("／");
	if (ent.tags.length) return ent.tags.slice(0, 3).join(" · ");
	const line = ent.body.split("\n").find((l) => l.trim());
	if (line) return line.trim().slice(0, 24);
	return ent.id;
}

class DbRefWidget extends WidgetType {
	constructor(
		private id: string,
		private word: string,
		private color: string | null,
		private onOpen?: (id: string) => void,
		private onMenu?: (id: string, word: string, e: MouseEvent) => void
	) {
		super();
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = "hl-db-ref";
		span.textContent = this.word;
		span.dataset.dbId = this.id;
		span.dataset.dbWord = this.word;
		if (this.color && /^#[0-9a-fA-F]{3,8}$/.test(this.color))
			span.style.textDecorationColor = this.color;
		// Handle both buttons on the widget itself: right-clicking must be
		// caught here (and stop propagation) so CodeMirror doesn't focus the
		// editor and unfold the marker into raw text before we react.
		span.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.button === 0) this.onOpen?.(this.id);
		});
		span.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onMenu?.(this.id, this.word, e);
		});
		return span;
	}

	eq(other: DbRefWidget): boolean {
		return (
			other.id === this.id &&
			other.word === this.word &&
			other.color === this.color
		);
	}

	ignoreEvent(): boolean {
		// Let CodeMirror ignore mouse events on the widget so it doesn't focus
		// the editor / move the cursor (which would unfold the marker); our own
		// DOM listeners handle left-click (open) and right-click (menu).
		return true;
	}
}

const hide = Decoration.replace({});
const boldMark = Decoration.mark({ class: "hl-le-bold" });
const italicMark = Decoration.mark({ class: "hl-le-italic" });
const codeMark = Decoration.mark({ class: "hl-le-code" });
const strikeMark = Decoration.mark({ class: "hl-le-strike" });
const bulletMark = Decoration.mark({ class: "hl-le-bullet" });

// Inline markdown spans rendered live (raw text reappears under the cursor):
// `{db …}` folds to an underlined word, plus **bold**, *italic*, `code` and
// ~~strikethrough~~; headings and list bullets get line-level styling.
function buildDecorations(
	view: EditorView,
	opts: LiveEditorOptions
): DecorationSet {
	// Raw text is only revealed under the cursor while the editor is focused;
	// an unfocused editor renders fully folded.
	const sel = view.hasFocus ? view.state.selection.ranges : [];
	const inside = (from: number, to: number): boolean =>
		sel.some((r) => r.from <= to && r.to >= from);
	const text = view.state.doc.toString();
	const ranges: ReturnType<Decoration["range"]>[] = [];
	// Replace decorations must never overlap; track their intervals.
	const taken: { from: number; to: number }[] = [];
	const free = (from: number, to: number): boolean =>
		!taken.some((s) => from < s.to && to > s.from);
	const claim = (from: number, to: number): void => {
		taken.push({ from, to });
	};

	let m: RegExpExecArray | null;
	const db = dbRegex();
	while ((m = db.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		claim(from, to);
		if (inside(from, to)) continue;
		ranges.push(
			Decoration.replace({
				widget: new DbRefWidget(
					m[1],
					m[2],
					opts.colorFor?.(m[1]) ?? null,
					opts.onOpenEntity,
					opts.onEntityMenu
				),
			}).range(from, to)
		);
	}

	const inline = (
		re: RegExp,
		markLen: number,
		mark: Decoration,
		group = 1
	): void => {
		re.lastIndex = 0;
		let hit: RegExpExecArray | null;
		while ((hit = re.exec(text)) !== null) {
			const start = hit.index + hit[0].indexOf(hit[group]) - markLen;
			const end = start + hit[group].length + markLen * 2;
			if (!free(start, end)) continue;
			claim(start, end);
			if (inside(start, end)) continue;
			ranges.push(hide.range(start, start + markLen));
			ranges.push(mark.range(start + markLen, end - markLen));
			ranges.push(hide.range(end - markLen, end));
		}
	};
	inline(/\*\*([^*\n]+)\*\*/g, 2, boldMark);
	inline(/(?<![*\\])\*(?!\*)([^*\n]+)\*(?!\*)/g, 1, italicMark);
	inline(/~~([^~\n]+)~~/g, 2, strikeMark);
	inline(/`([^`\n]+)`/g, 1, codeMark);

	// Line-level: ATX headings and list bullets.
	for (let n = 1; n <= view.state.doc.lines; n++) {
		const line = view.state.doc.line(n);
		const h = /^(#{1,6})\s+/.exec(line.text);
		if (h) {
			const level = Math.min(h[1].length, 3);
			ranges.push(
				Decoration.line({ class: `hl-le-heading hl-le-h${level}` }).range(
					line.from
				)
			);
			const end = line.from + h[0].length;
			if (!inside(line.from, line.to) && free(line.from, end)) {
				claim(line.from, end);
				ranges.push(hide.range(line.from, end));
			}
			continue;
		}
		const b = /^(\s*)([-*+]|\d+[.)])\s/.exec(line.text);
		if (b) {
			const from = line.from + b[1].length;
			const to = from + b[2].length;
			if (free(from, to)) {
				claim(from, to);
				ranges.push(bulletMark.range(from, to));
			}
		}
	}

	return Decoration.set(ranges, true);
}

export class LiveEditor {
	readonly view: EditorView;
	private suggestEl: HTMLDivElement;
	private cands: AliasCandidate[] = [];
	private selected = 0;
	private fragment = "";
	// Explicit `//` mode: doc offset of the trigger (replaced on confirm
	// together with the query); null while in plain automatic completion.
	private triggerFrom: number | null = null;
	private suggestOpen = false;

	constructor(
		private container: HTMLElement,
		private opts: LiveEditorOptions
	) {
		container.addClass("hl-le-container");
		opts.onEntityMenu = (id, word, e) => this.dbRefMenu(id, word, e);

		const self = this;
		const renderPlugin = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = buildDecorations(view, opts);
				}
				update(update: ViewUpdate) {
					if (
						update.docChanged ||
						update.selectionSet ||
						update.focusChanged
					)
						this.decorations = buildDecorations(update.view, opts);
				}
			},
			{ decorations: (v) => v.decorations }
		);

		const suggestKeys = Prec.highest(
			keymap.of([
				{
					key: "Tab",
					run: () => this.acceptSuggestion(),
				},
				{
					key: "Enter",
					run: () => this.acceptSuggestion(),
				},
				{
					key: "ArrowDown",
					run: () => this.moveSuggestion(1),
				},
				{
					key: "ArrowUp",
					run: () => this.moveSuggestion(-1),
				},
				{
					key: "Escape",
					run: () => {
						if (!this.suggestOpen) return false;
						this.closeSuggest();
						return true;
					},
				},
			])
		);

		this.view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: opts.value,
				extensions: [
					EditorView.lineWrapping,
					history(),
					cmPlaceholder(opts.placeholder ?? ""),
					renderPlugin,
					suggestKeys,
					keymap.of([...historyKeymap, ...defaultKeymap]),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) opts.onChange?.(u.state.doc.toString());
						if (u.docChanged || u.selectionSet) self.updateSuggest();
					}),
					EditorView.domEventHandlers({
						mousedown: (event, view) => {
							if (event.button !== 0) return false;
							const target = event.target as HTMLElement;
							if (target.closest(".cm-line")) return false;
							event.preventDefault();
							view.focus();
							return true;
						},
					}),
				],
			}),
		});

		// Mounted outside the editor with fixed positioning so it can
		// overflow the hosting modal instead of being clipped by it. It stays
		// inside the modal container so focus never leaves the modal.
		this.suggestEl = this.overlayParent().createDiv({
			cls: "hl-le-suggest",
		});
		this.suggestEl.hide();

		// Esc with the dropdown open must only close the dropdown — captured
		// here so the event never bubbles up to Obsidian's modal scope (which
		// would close the whole modal).
		container.addEventListener(
			"keydown",
			(e) => {
				if (e.key !== "Escape" || !this.suggestOpen) return;
				e.preventDefault();
				e.stopPropagation();
				this.closeSuggest();
			},
			true
		);

		if (opts.annotate)
			this.view.dom.addEventListener("contextmenu", (e) =>
				this.contextMenu(e)
			);
	}

	// For the hosting modal's Escape handling: close the completion dropdown
	// or right-click popover if one is open and report whether anything was
	// closed (Escape must not fall through to closing the whole modal then).
	closeSuggestIfOpen(): boolean {
		if (this.popoverEl) {
			this.closePopover();
			this.view.focus();
			return true;
		}
		if (!this.suggestOpen) return false;
		this.closeSuggest();
		return true;
	}

	getValue(): string {
		return this.view.state.doc.toString();
	}

	setValue(value: string): void {
		this.view.dispatch({
			changes: { from: 0, to: this.view.state.doc.length, insert: value },
		});
	}

	focus(): void {
		// Land the caret at the end of the document so nothing unfolds on open.
		this.view.dispatch({
			selection: { anchor: this.view.state.doc.length },
		});
		this.view.focus();
	}

	destroy(): void {
		this.closePopover();
		this.suggestEl.remove();
		this.view.destroy();
	}

	// --- completion dropdown -------------------------------------------

	private updateSuggest(): void {
		const ann = this.opts.annotate;
		const sel = this.view.state.selection.main;
		if (!ann || !sel.empty) {
			this.closeSuggest();
			return;
		}
		const before = this.view.state.doc.sliceString(0, sel.head);
		const trig = triggerQuery(before);
		if (trig) {
			// Explicit `//query` mode: loose matching, and even with zero
			// hits the 「＋ 新建词条」 row stays available.
			if (!trig.query.trim()) {
				this.closeSuggest();
				return;
			}
			this.cands = queryCandidates(trig.query, ann.entities());
			this.triggerFrom = trig.start;
			this.selected = 0;
			this.fragment = trig.query.trim();
			this.renderSuggest();
			return;
		}
		this.triggerFrom = null;
		const mode = ann.autoTrigger?.() ?? "normal";
		this.cands =
			mode === "off"
				? []
				: aliasCandidates(
						before,
						ann.entities(),
						undefined,
						mode === "conservative",
						ann.lastToken?.() ?? false
				  );
		if (!this.cands.length) {
			this.closeSuggest();
			return;
		}
		this.selected = 0;
		this.fragment = this.cands[0].matched;
		this.renderSuggest();
	}

	private renderSuggest(): void {
		const ann = this.opts.annotate;
		if (!ann) return;
		this.suggestEl.empty();
		this.cands.forEach((c, i) => {
			const row = this.suggestEl.createDiv({ cls: "hl-le-suggest-item" });
			if (i === this.selected) row.addClass("is-selected");
			row.createSpan({ cls: "hl-le-suggest-word", text: c.alias });
			const color = ann.typeColor(c.entity.type);
			const pill = row.createSpan({
				cls: "hl-le-suggest-type",
				text: c.entity.type || "?",
			});
			if (color) {
				pill.style.color = color;
				pill.style.borderColor = color;
			}
			const hint = entityHint(c.entity, c.alias);
			if (hint)
				row.createSpan({ cls: "hl-le-suggest-meta", text: hint });
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.selected = i;
				this.acceptSuggestion();
			});
		});
		const create = this.suggestEl.createDiv({
			cls: "hl-le-suggest-item hl-le-suggest-new",
		});
		if (this.selected === this.cands.length) create.addClass("is-selected");
		create.createSpan({ text: `＋ 新建词条 "${this.fragment}"` });
		create.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.selected = this.cands.length;
			this.acceptSuggestion();
		});
		const hint = this.suggestEl.createDiv({ cls: "hl-le-suggest-hint" });
		for (const [k, label] of [
			["↑↓", "选择"],
			["Tab", "确认"],
			["Esc", "关闭"],
		]) {
			hint.createSpan({ cls: "hl-le-key", text: k });
			hint.createSpan({ text: label });
		}

		// Anchor under the cursor, in viewport coordinates; flip above the
		// line when there is not enough room below.
		const sel = this.view.state.selection.main;
		const coords = this.view.coordsAtPos(sel.head);
		this.suggestOpen = true;
		this.suggestEl.show();
		if (coords) {
			const rect = this.suggestEl.getBoundingClientRect();
			const left = Math.max(
				8,
				Math.min(coords.left, window.innerWidth - rect.width - 8)
			);
			let top = coords.bottom + 6;
			if (top + rect.height > window.innerHeight - 8)
				top = Math.max(8, coords.top - rect.height - 6);
			this.suggestEl.style.left = `${left}px`;
			this.suggestEl.style.top = `${top}px`;
		}
	}

	private moveSuggestion(delta: number): boolean {
		if (!this.suggestOpen) return false;
		const total = this.cands.length + 1; // + "new entity" row
		this.selected = (this.selected + delta + total) % total;
		this.renderSuggest();
		return true;
	}

	private acceptSuggestion(): boolean {
		const ann = this.opts.annotate;
		if (!ann || !this.suggestOpen) return false;
		const sel = this.view.state.selection.main;
		const trigFrom = this.triggerFrom;
		if (this.selected >= this.cands.length) {
			const word = this.fragment;
			const from = trigFrom ?? sel.head - word.length;
			const to = sel.head;
			this.closeSuggest();
			ann.onCreate(word, (e) => this.insertMarker(from, to, e, word));
			return true;
		}
		const c = this.cands[this.selected];
		const from = trigFrom ?? sel.head - c.matched.length;
		this.closeSuggest();
		this.insertMarker(from, sel.head, c.entity, c.alias);
		return true;
	}

	private closeSuggest(): void {
		this.cands = [];
		this.triggerFrom = null;
		this.suggestOpen = false;
		this.suggestEl.hide();
	}

	// Replace [from, to) with the entity marker and land the cursor after it.
	insertMarker(
		from: number,
		to: number,
		entity: EntityEntry,
		word?: string
	): void {
		const text = word ?? this.view.state.doc.sliceString(from, to);
		const marker = makeDbMarker(entity.id, text);
		this.view.dispatch({
			changes: { from, to, insert: marker },
			selection: { anchor: from + marker.length },
		});
		this.view.focus();
	}

	// --- popover shell (right-click actions + link picker) --------------

	private popoverEl: HTMLDivElement | null = null;
	private onDocDown = (e: MouseEvent): void => {
		if (this.popoverEl && !this.popoverEl.contains(e.target as Node))
			this.closePopover();
	};
	private onDocKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			this.closePopover();
			this.view.focus();
		}
	};

	private overlayParent(): HTMLElement {
		return (
			(this.container.closest(".modal-container") as HTMLElement | null) ??
			document.body
		);
	}

	private openPopover(x: number, y: number): HTMLDivElement {
		this.closePopover();
		// Fixed positioning so it can overflow the hosting modal, but mounted
		// inside the modal container so focus (the link picker input) never
		// leaves the modal.
		const pop = this.overlayParent().createDiv({ cls: "hl-le-pop" });
		pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 320))}px`;
		pop.style.top = `${Math.max(8, Math.min(y + 4, window.innerHeight - 40))}px`;
		this.popoverEl = pop;
		document.addEventListener("mousedown", this.onDocDown, true);
		document.addEventListener("keydown", this.onDocKey, true);
		return pop;
	}

	private closePopover(): void {
		if (!this.popoverEl) return;
		this.popoverEl.remove();
		this.popoverEl = null;
		document.removeEventListener("mousedown", this.onDocDown, true);
		document.removeEventListener("keydown", this.onDocKey, true);
	}

	// --- right-click annotation ----------------------------------------

	private contextMenu(e: MouseEvent): void {
		// Folded entity markers handle their own contextmenu on the widget DOM
		// (DbRefWidget) so they can stop CodeMirror from unfolding them first.
		const ann = this.opts.annotate;
		if (!ann) return;
		const sel = this.view.state.selection.main;
		if (sel.empty) return;
		let from = sel.from;
		let to = sel.to;
		const raw = this.view.state.doc.sliceString(from, to);
		from += raw.length - raw.trimStart().length;
		to -= raw.length - raw.trimEnd().length;
		const word = raw.trim();
		if (!word) return;
		// Long selections, multi-line selections, and selections that already
		// contain `{db …}` markers aren't entity names — they get a plain-text
		// menu (clean copy, bulk unwrap) instead of the linking menu.
		const marks = parseDbMarks(word);
		const clean = stripDbMarkers(word);
		const cjk = (clean.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
		if (marks.length || /\n/.test(word) || cjk > 16 || clean.length > 48) {
			e.preventDefault();
			this.textSelectionMenu(e, from, to, word, clean, marks.length);
			return;
		}
		if (/[{}]/.test(word)) return;
		e.preventDefault();
		const pop = this.openPopover(e.clientX, e.clientY);
		const mk = (icon: string, label: string, hint: string): HTMLDivElement => {
			const row = pop.createDiv({ cls: "hl-le-pop-item" });
			row.createSpan({ cls: "hl-le-pop-icon", text: icon });
			row.createSpan({ cls: "hl-le-pop-label", text: label });
			if (hint) row.createSpan({ cls: "hl-le-suggest-meta", text: hint });
			return row;
		};
		if (this.opts.onCreateQuiz)
			mk("?", "Create cloze quiz", `“${clean.slice(0, 24)}”`).addEventListener(
				"mousedown",
				(ev) => {
					ev.preventDefault();
					this.closePopover();
					this.opts.onCreateQuiz?.(clean);
				}
			);
		// Entities whose label/alias matches the selection get a one-click row.
		const lower = word.toLowerCase();
		const matches = ann
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
			const color = ann.typeColor(ent.type);
			if (color) {
				const meta = row.querySelector(".hl-le-suggest-meta");
				(meta as HTMLElement | null)?.style.setProperty("color", color);
			}
			const hint = entityHint(ent, displayName(ent));
			if (hint)
				row.createSpan({ cls: "hl-le-suggest-meta", text: hint });
			row.addEventListener("mousedown", (ev) => {
				ev.preventDefault();
				this.closePopover();
				this.insertMarker(from, to, ent);
			});
		}
		mk("＋", "新建词条", `“${word}”`).addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			this.closePopover();
			ann.onCreate(word, (ent) => this.insertMarker(from, to, ent));
		});
		mk("⧉", "链接到已有词条…", "").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			this.openLinkPicker(from, to, word, e.clientX, e.clientY);
		});
	}

	// Plain-text menu for long / multi-line / already-annotated selections.
	private textSelectionMenu(
		e: MouseEvent,
		from: number,
		to: number,
		raw: string,
		clean: string,
		markCount: number
	): void {
		const pop = this.openPopover(e.clientX, e.clientY);
		pop.addClass("hl-le-textmenu");
		const mk = (icon: string, label: string, hint = ""): HTMLDivElement => {
			const row = pop.createDiv({ cls: "hl-le-pop-item" });
			row.createSpan({ cls: "hl-le-pop-icon", text: icon });
			row.createSpan({ cls: "hl-le-pop-label", text: label });
			if (hint)
				row.createSpan({ cls: "hl-le-suggest-meta", text: hint });
			return row;
		};
		if (this.opts.onCreateQuiz)
			mk("?", "Create cloze quiz", "Use selection as answer").addEventListener(
				"mousedown",
				(ev) => {
					ev.preventDefault();
					this.closePopover();
					this.opts.onCreateQuiz?.(clean);
				}
			);
		mk("⧉", "复制干净文本", markCount ? "去除标注语法" : "").addEventListener(
			"mousedown",
			(ev) => {
				ev.preventDefault();
				this.closePopover();
				void navigator.clipboard?.writeText(clean);
				new Notice("已复制干净文本");
			}
		);
		if (markCount)
			mk("⧉", "复制原文", "含标注语法").addEventListener(
				"mousedown",
				(ev) => {
					ev.preventDefault();
					this.closePopover();
					void navigator.clipboard?.writeText(raw);
					new Notice("已复制原文");
				}
			);
		mk("✂", "剪切").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			this.closePopover();
			void navigator.clipboard?.writeText(raw);
			this.view.dispatch({ changes: { from, to, insert: "" } });
		});
		if (markCount)
			mk("⊘", `取消选区内所有标注`, `${markCount} 处`).addEventListener(
				"mousedown",
				(ev) => {
					ev.preventDefault();
					this.closePopover();
					this.view.dispatch({
						changes: { from, to, insert: clean },
					});
					new Notice(
						`已取消 ${markCount} 处标注（Ctrl+Z 可撤销）`
					);
				}
			);
		if (!/\n/.test(clean))
			mk("⧉", "链接到已有词条…", "").addEventListener(
				"mousedown",
				(ev) => {
					ev.preventDefault();
					this.openLinkPicker(from, to, clean, e.clientX, e.clientY);
				}
			);
	}

	// Right-click menu on a folded entity marker.
	private dbRefMenu(id: string, word: string, e: MouseEvent): void {
		const pop = this.openPopover(e.clientX, e.clientY);
		const mk = (icon: string, label: string): HTMLDivElement => {
			const row = pop.createDiv({ cls: "hl-le-pop-item" });
			row.createSpan({ cls: "hl-le-pop-icon", text: icon });
			row.createSpan({ cls: "hl-le-pop-label", text: label });
			return row;
		};
		mk("✎", "编辑词条").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			this.closePopover();
			this.opts.onOpenEntity?.(id);
		});
		mk("↗", "打开词条页").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			this.closePopover();
			this.opts.onOpenEntityPage?.(id);
		});
		mk("⊘", "取消标注").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			this.closePopover();
			this.unannotate(id, word);
		});
		mk("⧉", "复制词条 ID").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			this.closePopover();
			void navigator.clipboard?.writeText(id);
			new Notice(`已复制词条 ID：${id}`);
		});
	}

	// Replace the `{db id word}` marker with its plain word (entity kept).
	private unannotate(id: string, word: string): void {
		const text = this.view.state.doc.toString();
		const re = dbRegex();
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (m[1] === id && m[2] === word) {
				this.view.dispatch({
					changes: {
						from: m.index,
						to: m.index + m[0].length,
						insert: m[2],
					},
				});
				return;
			}
		}
	}

	// Inline fuzzy picker over every entity, anchored at the selection — no
	// native modal.
	private openLinkPicker(
		from: number,
		to: number,
		word: string,
		x: number,
		y: number
	): void {
		const ann = this.opts.annotate;
		if (!ann) return;
		const pop = this.openPopover(x, y);
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
			this.closePopover();
			this.insertMarker(from, to, ent);
		};
		const render = (): void => {
			const q = input.value.trim();
			const fuzzy = q ? prepareFuzzySearch(q) : null;
			items = ann
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
				row.createSpan({
					cls: "hl-le-suggest-word",
					text: displayName(ent),
				});
				const color = ann.typeColor(ent.type);
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
					.join("／");
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

	// Entities list can change (a new entity created mid-edit).
	refreshDecorations(): void {
		this.view.dispatch({});
	}
}
