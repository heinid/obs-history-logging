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
	queryCandidates,
	triggerQuery,
} from "./db-marker";
import { EntityEntry } from "./db-format";
import { generateId } from "./id";
import {
	openDbEntityEditor,
	openDbLangMenu,
	openDbRefMenu,
	wireDbRef,
} from "./quiz-render";
import { entityHint } from "./live-editor";
import { EntityModal } from "./entity-modal";

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
		const plugin = this.plugin;
		const entity: EntityEntry = {
			id: generateId((id) =>
				plugin.dbVault.entities.some((e) => e.id === id)
			),
			type: "",
			labels: [
				{
					lang: plugin.settings.entityLangs[0] ?? "zh",
					text: word,
				},
			],
			readings: [],
			audios: [],
			tags: [],
			body: "",
		};
		new EntityModal(plugin.app, plugin, entity, true, (saved) => {
			insertVaultMarker(editor, from, end, saved, word);
		}).open();
	}
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
