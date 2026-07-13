import { App, MarkdownView, TFile } from "obsidian";
import { evLocationIndex } from "./scan";

// Locate an inline `{ev <id> ...}` marker anywhere in the vault and open the
// note at that position. The id is globally unique, so a plain scan suffices;
// no Obsidian block-id is required. The last-known location index is tried
// first so this stays fast on big vaults; only a miss falls back to a scan.
export async function jumpToEv(
	app: App,
	id: string,
	newTab = false
): Promise<boolean> {
	const needle = `{ev ${id} `;
	const known = evLocationIndex.get(id);
	if (known) {
		const file = app.vault.getAbstractFileByPath(known);
		if (file instanceof TFile) {
			const content = (await app.vault.cachedRead(file)).replace(
				/\r\n/g,
				"\n"
			);
			const idx = content.indexOf(needle);
			if (idx !== -1) {
				await openMarker(app, file, content, idx, needle, newTab);
				return true;
			}
		}
	}
	for (const file of app.vault.getMarkdownFiles()) {
		const content = (await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");
		const idx = content.indexOf(needle);
		if (idx === -1) continue;
		evLocationIndex.set(id, file.path);
		await openMarker(app, file, content, idx, needle, newTab);
		return true;
	}
	return false;
}

// Select and flash the whole `{ev … }` marker so the jump target is obvious.
async function openMarker(
	app: App,
	file: TFile,
	content: string,
	markerStart: number,
	needle: string,
	newTab: boolean
): Promise<void> {
	const end = content.indexOf("}", markerStart + needle.length);
	const length = end === -1 ? 0 : end - markerStart + 1;
	await openAt(app, file, markerStart, length, newTab);
}

// Open a specific file at a char offset (used by the timeline view). Cached
// scan offsets drift once the note is edited, so when the marker's id is known
// we re-find it in the current file text and use that fresh offset instead.
export async function jumpToLocation(
	app: App,
	filePath: string,
	offset: number,
	length = 0,
	evId?: string
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(filePath);
	// The cached path can be momentarily stale right after a rename; fall back
	// to locating the marker by its globally-unique id anywhere in the vault.
	if (!(file instanceof TFile)) {
		if (evId) await jumpToEv(app, evId);
		return;
	}
	let at = offset;
	if (evId) {
		const idx = (await app.vault.cachedRead(file))
			.replace(/\r\n/g, "\n")
			.indexOf(`{ev ${evId} `);
		if (idx !== -1) {
			// The tag itself sits just past `{ev <id> ` inside the marker.
			const inner = `{ev ${evId} `.length;
			at = idx + inner;
		}
	}
	await openAt(app, file, at, length);
}

async function openAt(
	app: App,
	file: TFile,
	offset: number,
	length = 0,
	newTab = false
): Promise<void> {
	const leaf = app.workspace.getLeaf(newTab ? "tab" : false);
	await leaf.openFile(file);
	const view = await whenEditorReady(leaf.view);
	if (!view) return;
	const editor = view.editor;
	const from = editor.offsetToPos(offset);
	const to = editor.offsetToPos(offset + length);
	if (length > 0) {
		editor.setSelection(from, to);
	} else {
		editor.setCursor(from);
	}
	editor.scrollIntoView({ from, to }, true);
	flashLines(view, offset, offset + length);
}

// A freshly opened tab mounts its CodeMirror editor asynchronously; setting
// the cursor before it exists silently no-ops (the reported "jump did nothing
// when a new tab opened"). Poll briefly for the editor to appear.
async function whenEditorReady(
	view: unknown,
	tries = 20
): Promise<MarkdownView | null> {
	for (let i = 0; i < tries; i++) {
		if (view instanceof MarkdownView && view.editor) return view;
		await new Promise((resolve) => window.setTimeout(resolve, 20));
	}
	return view instanceof MarkdownView ? view : null;
}

// Pulse a bright, colorful highlight over the jumped-to line(s). The tag pill
// paints its own background on top of the CM selection, hiding a selection-
// based flash, so we flash the whole `.cm-line` element(s) the range spans —
// reliably visible in both source and live-preview modes. Retries briefly in
// case the editor hasn't laid the lines out yet (freshly opened tab).
function flashLines(view: MarkdownView, from: number, to: number): void {
	const cm = (view.editor as unknown as { cm?: EditorFlashView }).cm;
	if (!cm?.dom || typeof cm.domAtPos !== "function") return;
	const lineAt = (pos: number): HTMLElement | null => {
		try {
			const node = cm.domAtPos(pos).node;
			const el = node instanceof HTMLElement ? node : node.parentElement;
			return el?.closest(".cm-line") ?? null;
		} catch {
			return null;
		}
	};
	let tries = 0;
	const run = (): void => {
		const start = lineAt(from);
		const end = lineAt(to);
		if (!start) {
			if (tries++ < 15) window.setTimeout(run, 40);
			return;
		}
		const lines = new Set<HTMLElement>([start]);
		if (end) {
			for (
				let el: Element | null = start;
				el && el !== end.nextElementSibling;
				el = el.nextElementSibling
			)
				if (el instanceof HTMLElement && el.hasClass("cm-line"))
					lines.add(el);
			lines.add(end);
		}
		for (const line of lines) {
			line.removeClass("hl-flash-line");
			void line.offsetWidth; // restart the animation if re-triggered
			line.addClass("hl-flash-line");
			window.setTimeout(() => line.removeClass("hl-flash-line"), 1600);
		}
	};
	window.setTimeout(run, 30);
}

interface EditorFlashView {
	dom: HTMLElement;
	domAtPos(pos: number): { node: Node; offset: number };
}
