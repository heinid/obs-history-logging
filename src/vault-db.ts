// Vault-wide entity features, gated by note tags: in a note carrying one of
// the configured enable-tags, `{db <id> <text>}` markers render as clickable
// entity references (reading view + Live Preview), the completion dropdown
// works in the editor, and mask mode applies. Untagged notes are untouched.

import {
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Editor,
	MarkdownView,
	Notice,
	TFile,
	editorInfoField,
	getAllTags,
} from "obsidian";
import {
	EditorView,
	ViewPlugin,
	ViewUpdate,
	Decoration,
	DecorationSet,
	WidgetType,
} from "@codemirror/view";
import type HistoryLoggingPlugin from "./main";
import { hasDbTag } from "./db-gate";
import {
	AliasCandidate,
	aliasCandidates,
	dbRegex,
	makeDbMarker,
	parseDbMarks,
	queryCandidates,
	stripDbMarkers,
	triggerQuery,
} from "./db-marker";
import { EntityEntry, displayName } from "./db-format";
import { generateId } from "./id";
import {
	openDbEntityEditor,
	openDbLangMenu,
	openDbRefMenu,
	wireDbRef,
} from "./quiz-render";
import { entityHint } from "./live-editor";
import { EntityModal, EntitySuggestModal } from "./entity-modal";

// Whether the entity features are enabled for a note, by its tags.
export function dbEnabledFor(
	plugin: HistoryLoggingPlugin,
	path: string
): boolean {
	const enable = plugin.settings.dbEnableTags;
	if (!enable.length) return false;
	const file = plugin.app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;
	const cache = plugin.app.metadataCache.getFileCache(file);
	if (!cache) return false;
	return hasDbTag(getAllTags(cache) ?? [], enable);
}

// --- shared entity cache ------------------------------------------------
// Editor decorations and the completion dropdown need synchronous access to
// the entity list and type colors; the plugin refreshes this cache when the
// data files change.

export class DbVaultCache {
	entities: EntityEntry[] = [];
	private typeColors = new Map<string, string>();
	private idColors = new Map<string, string>();

	constructor(private plugin: HistoryLoggingPlugin) {}

	async refresh(): Promise<void> {
		const [entities, types] = await Promise.all([
			this.plugin.store.readEntities(),
			this.plugin.store.readDbTypes(),
		]);
		this.entities = [...entities.values()];
		this.typeColors = new Map(types.map((t) => [t.name, t.color]));
		this.idColors = new Map(
			this.entities.map((e) => [
				e.id,
				this.typeColors.get(e.type) ?? "",
			])
		);
	}

	typeColor(name: string): string | null {
		return this.typeColors.get(name) ?? null;
	}

	// Underline color for an entity id; null = unknown id (plain text).
	colorFor(id: string): string | null {
		return this.idColors.get(id) ?? null;
	}
}

// --- unannotate in a vault note -----------------------------------------

// Replace one `{db id text}` marker in a file with its plain text. `near`
// (a character offset) picks between identical markers when known.
async function unannotateInFile(
	plugin: HistoryLoggingPlugin,
	path: string,
	id: string,
	text: string,
	near?: number
): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return;
	const content = await plugin.app.vault.read(file);
	const re = dbRegex();
	const hits: { from: number; to: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null)
		if (m[1] === id && m[2] === text)
			hits.push({ from: m.index, to: m.index + m[0].length });
	if (!hits.length) return;
	let pick = hits[0];
	if (near !== undefined)
		pick = hits.reduce((a, b) =>
			Math.abs(b.from - near) < Math.abs(a.from - near) ? b : a
		);
	else if (hits.length > 1) {
		new Notice("这个标注在笔记里出现多次，请在编辑模式下取消。");
		return;
	}
	await plugin.app.vault.modify(
		file,
		content.slice(0, pick.from) + text + content.slice(pick.to)
	);
	new Notice("已取消标注（Ctrl+Z 可撤销）");
}

// --- reading view -------------------------------------------------------

// Fold `{db …}` markers in rendered reading-view text into clickable entity
// spans. Only text nodes are touched; code blocks keep the raw syntax.
export function createVaultDbProcessor(plugin: HistoryLoggingPlugin) {
	return (el: HTMLElement, ctx: { sourcePath: string }) => {
		if (!dbEnabledFor(plugin, ctx.sourcePath)) return;
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const t = n as Text;
			if (t.parentElement?.closest("code, pre")) continue;
			if (dbRegex().test(t.textContent ?? "")) nodes.push(t);
		}
		void (async () => {
			const cache = plugin.dbVault;
			const mask = plugin.settings.dbMaskMode;
			for (const node of nodes) {
				const text = node.textContent ?? "";
				const frag = document.createDocumentFragment();
				let pos = 0;
				const re = dbRegex();
				let m: RegExpExecArray | null;
				while ((m = re.exec(text)) !== null) {
					frag.append(text.slice(pos, m.index));
					pos = m.index + m[0].length;
					const id = m[1];
					const word = m[2];
					const color = cache.colorFor(id);
					if (color === null) {
						frag.append(word);
						continue;
					}
					const span = document.createElement("span");
					span.className = "hl-db-ref";
					span.textContent = word;
					span.dataset.dbId = id;
					if (/^#[0-9a-fA-F]{3,8}$/.test(color))
						span.style.textDecorationColor = color;
					wireDbRef(plugin, span, id, {
						mask,
						onUnannotate: () =>
							void unannotateInFile(
								plugin,
								ctx.sourcePath,
								id,
								word
							),
					});
					frag.append(span);
				}
				frag.append(text.slice(pos));
				node.replaceWith(frag);
			}
		})();
	};
}

// --- Live Preview -------------------------------------------------------

class VaultDbRefWidget extends WidgetType {
	constructor(
		private plugin: HistoryLoggingPlugin,
		private id: string,
		private word: string,
		private color: string,
		private mask: boolean
	) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		const span = document.createElement("span");
		span.className = "hl-db-ref";
		span.textContent = this.word;
		span.dataset.dbId = this.id;
		if (/^#[0-9a-fA-F]{3,8}$/.test(this.color))
			span.style.textDecorationColor = this.color;
		const unannotate = (): void => {
			const near = view.posAtDOM(span);
			const info = view.state.field(editorInfoField);
			const path = info.file?.path;
			if (path)
				void unannotateInFile(
					this.plugin,
					path,
					this.id,
					this.word,
					near
				);
		};
		if (this.mask) {
			span.classList.add("hl-db-mask");
			span.setAttribute("aria-label", "点击揭开");
			span.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.button !== 0) return;
				const hidden = span.classList.contains("hl-db-mask");
				span.classList.toggle("hl-db-mask", !hidden);
				span.setAttribute(
					"aria-label",
					hidden ? "点击遮住" : "点击揭开"
				);
			});
			span.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (span.classList.contains("hl-db-mask"))
					openDbLangMenu(this.plugin, span, this.id, e);
				else openDbRefMenu(this.plugin, this.id, e, unannotate);
			});
			return span;
		}
		span.setAttribute("aria-label", "Edit entity");
		span.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.button === 0) openDbEntityEditor(this.plugin, this.id);
		});
		span.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			openDbRefMenu(this.plugin, this.id, e, unannotate);
		});
		return span;
	}

	eq(other: VaultDbRefWidget): boolean {
		return (
			other.id === this.id &&
			other.word === this.word &&
			other.color === this.color &&
			other.mask === this.mask
		);
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function buildVaultDbDecorations(
	view: EditorView,
	plugin: HistoryLoggingPlugin
): DecorationSet {
	const path = view.state.field(editorInfoField).file?.path;
	if (!path || !dbEnabledFor(plugin, path)) return Decoration.none;
	const sel = view.state.selection.ranges;
	const mask = plugin.settings.dbMaskMode;
	const ranges: ReturnType<Decoration["range"]>[] = [];
	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		const re = dbRegex();
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const start = from + m.index;
			const end = start + m[0].length;
			// Keep the raw text editable while the cursor is inside.
			if (sel.some((r) => r.from <= end && r.to >= start)) continue;
			const color = plugin.dbVault.colorFor(m[1]);
			if (color === null) continue;
			ranges.push(
				Decoration.replace({
					widget: new VaultDbRefWidget(
						plugin,
						m[1],
						m[2],
						color,
						mask
					),
				}).range(start, end)
			);
		}
	}
	return Decoration.set(ranges, true);
}

export function createVaultDbExtension(plugin: HistoryLoggingPlugin) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildVaultDbDecorations(view, plugin);
			}
			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.selectionSet ||
					update.focusChanged
				)
					this.decorations = buildVaultDbDecorations(
						update.view,
						plugin
					);
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

// --- completion (global EditorSuggest) -----------------------------------

type DbSuggestion =
	| { kind: "cand"; cand: AliasCandidate }
	| { kind: "new" };

export class VaultDbSuggest extends EditorSuggest<DbSuggestion> {
	private cands: AliasCandidate[] = [];
	private fragment = "";
	// `//` trigger start (character offset in the line); null in auto mode.
	private triggerCh: number | null = null;

	constructor(private plugin: HistoryLoggingPlugin) {
		super(plugin.app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null
	): EditorSuggestTriggerInfo | null {
		const plugin = this.plugin;
		if (!file || !dbEnabledFor(plugin, file.path)) return null;
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const trig = triggerQuery(before);
		if (trig) {
			if (!trig.query.trim()) return null;
			this.cands = queryCandidates(
				trig.query,
				plugin.dbVault.entities
			);
			this.fragment = trig.query.trim();
			this.triggerCh = trig.start;
			return {
				start: { line: cursor.line, ch: trig.start },
				end: cursor,
				query: trig.query,
			};
		}
		this.triggerCh = null;
		const mode = plugin.settings.completeAutoTrigger;
		if (mode === "off") return null;
		this.cands = aliasCandidates(
			before,
			plugin.dbVault.entities,
			undefined,
			mode === "conservative",
			plugin.settings.completeLastToken
		);
		if (!this.cands.length) return null;
		this.fragment = this.cands[0].matched;
		return {
			start: {
				line: cursor.line,
				ch: cursor.ch - this.cands[0].matched.length,
			},
			end: cursor,
			query: this.cands[0].matched,
		};
	}

	getSuggestions(_ctx: EditorSuggestContext): DbSuggestion[] {
		return [
			...this.cands.map(
				(cand): DbSuggestion => ({ kind: "cand", cand })
			),
			{ kind: "new" },
		];
	}

	renderSuggestion(s: DbSuggestion, el: HTMLElement): void {
		el.addClass("hl-le-suggest-item", "hl-vault-suggest-item");
		if (s.kind === "new") {
			el.addClass("hl-le-suggest-new");
			el.createSpan({ text: `＋ 新建词条 "${this.fragment}"` });
			return;
		}
		const c = s.cand;
		el.createSpan({ cls: "hl-le-suggest-word", text: c.alias });
		const pill = el.createSpan({
			cls: "hl-le-suggest-type",
			text: c.entity.type || "?",
		});
		const color = this.plugin.dbVault.typeColor(c.entity.type);
		if (color) {
			pill.style.color = color;
			pill.style.borderColor = color;
		}
		const hint = entityHint(c.entity, c.alias);
		if (hint) el.createSpan({ cls: "hl-le-suggest-meta", text: hint });
	}

	selectSuggestion(s: DbSuggestion): void {
		const ctx = this.context;
		if (!ctx) return;
		const { editor, end } = ctx;
		const fromCh =
			this.triggerCh ??
			end.ch -
				(s.kind === "cand"
					? s.cand.matched.length
					: this.fragment.length);
		const from = { line: end.line, ch: Math.max(0, fromCh) };
		if (s.kind === "cand") {
			insertVaultMarker(editor, from, end, s.cand.entity, s.cand.alias);
			return;
		}
		const word = this.fragment;
		createEntityForWord(this.plugin, word, (saved) =>
			insertVaultMarker(editor, from, end, saved, word)
		);
	}
}

// --- selection menu (command + hotkey) -----------------------------------

// Rectangle of the text the popover is anchored to, in viewport pixels.
interface AnchorRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

// A floating popover, same look as the LiveEditor menus. Centered below the
// anchor; flips above when there is no room underneath.
function popAt(anchor: AnchorRect): {
	mk: (icon: string, label: string, hint?: string) => HTMLDivElement;
	close: () => void;
} {
	const pop = document.body.createDiv({ cls: "hl-le-pop hl-le-textmenu" });
	pop.style.visibility = "hidden";
	// Rows are added after this returns; measure and place on the next frame.
	requestAnimationFrame(() => {
		const w = pop.offsetWidth;
		const h = pop.offsetHeight;
		const cx = (anchor.left + anchor.right) / 2;
		const left = Math.max(8, Math.min(cx - w / 2, window.innerWidth - w - 8));
		let top = anchor.bottom + 6;
		if (top + h > window.innerHeight - 8) top = anchor.top - h - 6;
		pop.style.left = `${left}px`;
		pop.style.top = `${Math.max(8, top)}px`;
		pop.style.visibility = "";
	});
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
	const mk = (icon: string, label: string, hint = ""): HTMLDivElement => {
		const row = pop.createDiv({ cls: "hl-le-pop-item" });
		row.createSpan({ cls: "hl-le-pop-icon", text: icon });
		row.createSpan({ cls: "hl-le-pop-label", text: label });
		if (hint) row.createSpan({ cls: "hl-le-suggest-meta", text: hint });
		return row;
	};
	return { mk, close };
}

// The selection's anchor rectangle: from the CodeMirror pixel coords of the
// selection start and end. Multi-line selections anchor on the first line.
function selectionRect(
	plugin: HistoryLoggingPlugin,
	editor: Editor,
	from: EditorPosition,
	to: EditorPosition
): AnchorRect {
	const md = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	const cmDom = md?.containerEl.querySelector<HTMLElement>(".cm-editor");
	const cm = cmDom ? EditorView.findFromDOM(cmDom) : null;
	if (cm) {
		const clamp = (p: EditorPosition): number =>
			Math.min(editor.posToOffset(p), cm.state.doc.length);
		const a = cm.coordsAtPos(clamp(from));
		const b = cm.coordsAtPos(clamp(to));
		if (a) {
			const sameLine = b && Math.abs(b.top - a.top) < 2;
			return {
				left: a.left,
				right: sameLine && b ? b.right : a.right,
				top: a.top,
				bottom: a.bottom,
			};
		}
	}
	const sel = window.getSelection();
	if (sel && sel.rangeCount) {
		const r = sel.getRangeAt(0).getBoundingClientRect();
		if (r.width || r.height || r.left || r.top)
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
	}
	const cx = window.innerWidth / 2;
	const cy = window.innerHeight / 3;
	return { left: cx, right: cx, top: cy, bottom: cy };
}

// The command-invoked selection menu: annotate a plain-text selection (or
// the word under the caret) as an entity, or clean up markers inside a
// larger selection. Mirrors the LiveEditor right-click menu minus quiz.
export function openDbSelectionMenu(
	plugin: HistoryLoggingPlugin,
	editor: Editor,
	path: string | undefined
): void {
	if (!path || !dbEnabledFor(plugin, path)) {
		new Notice("当前笔记未启用词条功能（需带启用标签）。");
		return;
	}
	let from = editor.getCursor("from");
	let to = editor.getCursor("to");
	if (from.line === to.line && from.ch === to.ch) {
		const word = editor.wordAt(from);
		if (!word) {
			new Notice("请先选中要标注的文字。");
			return;
		}
		from = word.from;
		to = word.to;
	}
	let raw = editor.getRange(from, to);
	// Trim whitespace off the selection edges (single-line only).
	if (!raw.includes("\n")) {
		const lead = raw.length - raw.trimStart().length;
		const tail = raw.length - raw.trimEnd().length;
		from = { line: from.line, ch: from.ch + lead };
		to = { line: to.line, ch: to.ch - tail };
		raw = raw.trim();
	}
	if (!raw) {
		new Notice("请先选中要标注的文字。");
		return;
	}
	const marks = parseDbMarks(raw);
	const clean = stripDbMarkers(raw);
	const { mk, close } = popAt(selectionRect(plugin, editor, from, to));

	if (!marks.length && !raw.includes("\n")) {
		// Annotation: link to a matching entity, create one, or pick by hand.
		for (const c of queryCandidates(raw, plugin.dbVault.entities, 3)) {
			const row = mk("⇢", `链接到 ${displayName(c.entity)}`, c.entity.type || "");
			const color = plugin.dbVault.typeColor(c.entity.type);
			const meta = row.querySelector<HTMLElement>(".hl-le-suggest-meta");
			if (color && meta) meta.style.color = color;
			row.addEventListener("mousedown", (ev) => {
				ev.preventDefault();
				close();
				insertVaultMarker(editor, from, to, c.entity, raw);
			});
		}
		mk("＋", `新建词条 "${raw}"`).addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			close();
			createEntityForWord(plugin, raw, (saved) =>
				insertVaultMarker(editor, from, to, saved, raw)
			);
		});
		mk("⧉", "链接到已有词条…").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			close();
			new EntitySuggestModal(plugin.app, plugin.dbVault.entities, (e) =>
				insertVaultMarker(editor, from, to, e, raw)
			).open();
		});
		return;
	}

	// Cleanup / copy menu for selections with markers (or multi-line).
	mk("⧉", "复制干净文本", marks.length ? "去除标注语法" : "").addEventListener(
		"mousedown",
		(ev) => {
			ev.preventDefault();
			close();
			void navigator.clipboard?.writeText(clean);
			new Notice("已复制干净文本");
		}
	);
	if (marks.length) {
		mk("⧉", "复制原文", "含标注语法").addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			close();
			void navigator.clipboard?.writeText(raw);
			new Notice("已复制原文");
		});
		mk(
			"⊘",
			"取消选区内所有标注",
			`${marks.length} 处`
		).addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			close();
			editor.replaceRange(clean, from, to);
			new Notice(`已取消 ${marks.length} 处标注（Ctrl+Z 可撤销）`);
		});
	}
}

function createEntityForWord(
	plugin: HistoryLoggingPlugin,
	word: string,
	apply: (saved: EntityEntry) => void
): void {
	const entity: EntityEntry = {
		id: generateId((id) =>
			plugin.dbVault.entities.some((e) => e.id === id)
		),
		type: "",
		labels: [
			{ lang: plugin.settings.entityLangs[0] ?? "zh", text: word },
		],
		readings: [],
		audios: [],
		tags: [],
		body: "",
	};
	new EntityModal(plugin.app, plugin, entity, true, apply).open();
}

function insertVaultMarker(
	editor: Editor,
	from: EditorPosition,
	to: EditorPosition,
	entity: EntityEntry,
	word: string
): void {
	const marker = makeDbMarker(entity.id, word);
	editor.replaceRange(marker, from, to);
	editor.setCursor({ line: from.line, ch: from.ch + marker.length });
}
