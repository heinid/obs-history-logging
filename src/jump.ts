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
			const idx = (await app.vault.cachedRead(file))
				.replace(/\r\n/g, "\n")
				.indexOf(needle);
			if (idx !== -1) {
				await openAt(app, file, idx, 0, newTab);
				return true;
			}
		}
	}
	for (const file of app.vault.getMarkdownFiles()) {
		const content = (await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");
		const idx = content.indexOf(needle);
		if (idx === -1) continue;
		evLocationIndex.set(id, file.path);
		await openAt(app, file, idx, 0, newTab);
		return true;
	}
	return false;
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
	if (!(file instanceof TFile)) return;
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
		flashRange(view);
	} else {
		editor.setCursor(from);
	}
	editor.scrollIntoView({ from, to }, true);
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

// Briefly highlight the current selection in the editor so the jump target
// is obvious, then let it settle back to a normal selection.
function flashRange(view: MarkdownView): void {
	const cm = (view.editor as unknown as { cm?: EditorFlashView }).cm;
	if (!cm?.dom) return;
	const run = () => {
		const sel = cm.dom.querySelector(".cm-selectionBackground");
		if (!(sel instanceof HTMLElement)) return;
		sel.classList.add("hl-flash");
		window.setTimeout(() => sel.classList.remove("hl-flash"), 1200);
	};
	// Let the editor paint the selection first.
	window.setTimeout(run, 30);
}

interface EditorFlashView {
	dom: HTMLElement;
}
