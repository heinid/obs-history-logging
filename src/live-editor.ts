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
import { EditorState, Prec, RangeSetBuilder } from "@codemirror/state";
import { Menu } from "obsidian";
import { EntityEntry } from "./db-format";
import {
	AliasCandidate,
	aliasCandidates,
	dbRegex,
	makeDbMarker,
} from "./db-marker";

export interface LiveEditorOptions {
	value: string;
	placeholder?: string;
	// Called on every document change (caller debounces the actual write).
	onChange?: (value: string) => void;
	// Underline colour for an entity id; null = render as plain text.
	colorFor?: (id: string) => string | null;
	onOpenEntity?: (id: string) => void;
	// Entity annotation support (completion dropdown + right-click menu).
	annotate?: {
		entities: () => EntityEntry[];
		typeColor: (typeName: string) => string | null;
		// "＋ New entity" flows: open the entity editor, then call apply.
		onCreate: (word: string, apply: (e: EntityEntry) => void) => void;
		onLink: (apply: (e: EntityEntry) => void) => void;
	};
}

class DbRefWidget extends WidgetType {
	constructor(
		private id: string,
		private word: string,
		private color: string | null,
		private onOpen?: (id: string) => void
	) {
		super();
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = "hl-db-ref";
		span.textContent = this.word;
		if (this.color && /^#[0-9a-fA-F]{3,8}$/.test(this.color))
			span.style.textDecorationColor = this.color;
		span.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onOpen?.(this.id);
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
		return false;
	}
}

const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const boldMark = Decoration.mark({ class: "hl-le-bold" });
const hide = Decoration.replace({});

function buildDecorations(
	view: EditorView,
	opts: LiveEditorOptions
): DecorationSet {
	const sel = view.state.selection.ranges;
	const inside = (from: number, to: number): boolean =>
		sel.some((r) => r.from <= to && r.to >= from);
	const text = view.state.doc.toString();
	const spans: { from: number; to: number; deco: Decoration }[] = [];

	let m: RegExpExecArray | null;
	const db = dbRegex();
	while ((m = db.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (inside(from, to)) continue;
		spans.push({
			from,
			to,
			deco: Decoration.replace({
				widget: new DbRefWidget(
					m[1],
					m[2],
					opts.colorFor?.(m[1]) ?? null,
					opts.onOpenEntity
				),
			}),
		});
	}

	BOLD_RE.lastIndex = 0;
	while ((m = BOLD_RE.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (inside(from, to)) continue;
		if (spans.some((s) => from < s.to && to > s.from)) continue;
		spans.push({ from, to: from + 2, deco: hide });
		spans.push({ from: from + 2, to: to - 2, deco: boldMark });
		spans.push({ from: to - 2, to, deco: hide });
	}

	spans.sort((a, b) => a.from - b.from);
	const builder = new RangeSetBuilder<Decoration>();
	for (const s of spans) builder.add(s.from, s.to, s.deco);
	return builder.finish();
}

export class LiveEditor {
	readonly view: EditorView;
	private suggestEl: HTMLDivElement;
	private cands: AliasCandidate[] = [];
	private selected = 0;
	private fragment = "";

	constructor(
		private container: HTMLElement,
		private opts: LiveEditorOptions
	) {
		container.addClass("hl-le-container");

		const self = this;
		const renderPlugin = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = buildDecorations(view, opts);
				}
				update(update: ViewUpdate) {
					if (update.docChanged || update.selectionSet)
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
						if (!this.cands.length) return false;
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
					cmPlaceholder(opts.placeholder ?? ""),
					renderPlugin,
					suggestKeys,
					EditorView.updateListener.of((u) => {
						if (u.docChanged) opts.onChange?.(u.state.doc.toString());
						if (u.docChanged || u.selectionSet) self.updateSuggest();
					}),
				],
			}),
		});

		this.suggestEl = container.createDiv({ cls: "hl-le-suggest" });
		this.suggestEl.hide();

		if (opts.annotate)
			this.view.dom.addEventListener("contextmenu", (e) =>
				this.contextMenu(e)
			);
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
		this.view.focus();
	}

	destroy(): void {
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
		this.cands = aliasCandidates(before, ann.entities());
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
			const others = c.entity.labels
				.map((l) => l.text)
				.filter((t) => t !== c.alias)
				.slice(0, 3)
				.join(" · ");
			if (others)
				row.createSpan({ cls: "hl-le-suggest-meta", text: others });
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

		// Anchor under the cursor.
		const sel = this.view.state.selection.main;
		const coords = this.view.coordsAtPos(sel.head);
		const box = this.container.getBoundingClientRect();
		if (coords) {
			this.suggestEl.style.left = `${Math.max(
				0,
				Math.min(coords.left - box.left, box.width - 280)
			)}px`;
			this.suggestEl.style.top = `${coords.bottom - box.top + 6}px`;
		}
		this.suggestEl.show();
	}

	private moveSuggestion(delta: number): boolean {
		if (!this.cands.length) return false;
		const total = this.cands.length + 1; // + "new entity" row
		this.selected = (this.selected + delta + total) % total;
		this.renderSuggest();
		return true;
	}

	private acceptSuggestion(): boolean {
		const ann = this.opts.annotate;
		if (!ann || !this.cands.length) return false;
		const sel = this.view.state.selection.main;
		if (this.selected === this.cands.length) {
			const word = this.fragment;
			const from = sel.head - word.length;
			this.closeSuggest();
			ann.onCreate(word, (e) =>
				this.insertMarker(from, from + word.length, e, word)
			);
			return true;
		}
		const c = this.cands[this.selected];
		const from = sel.head - c.matched.length;
		this.closeSuggest();
		this.insertMarker(from, sel.head, c.entity, c.alias);
		return true;
	}

	private closeSuggest(): void {
		this.cands = [];
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

	// --- right-click annotation ----------------------------------------

	private contextMenu(e: MouseEvent): void {
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
		if (!word || /[{}\n]/.test(word)) return;
		e.preventDefault();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(`Annotate "${word}" as new entity…`)
				.setIcon("plus")
				.onClick(() =>
					ann.onCreate(word, (ent) => this.insertMarker(from, to, ent))
				)
		);
		menu.addItem((item) =>
			item
				.setTitle(`Link "${word}" to existing entity…`)
				.setIcon("link")
				.onClick(() =>
					ann.onLink((ent) => this.insertMarker(from, to, ent))
				)
		);
		menu.showAtMouseEvent(e);
	}

	// Entities list can change (a new entity created mid-edit).
	refreshDecorations(): void {
		this.view.dispatch({});
	}
}
