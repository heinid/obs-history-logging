import { App, MarkdownView, TFile } from "obsidian";

// Locate an inline `{ev <id> ...}` marker anywhere in the vault and open the
// note at that position. The id is globally unique, so a plain scan suffices;
// no Obsidian block-id is required.
export async function jumpToEv(
	app: App,
	id: string,
	newTab = false
): Promise<boolean> {
	const needle = `{ev ${id} `;
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		const content = (await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");
		const idx = content.indexOf(needle);
		if (idx === -1) continue;
		await openAt(app, file, idx, 0, newTab);
		return true;
	}
	return false;
}

// Open a specific file at a char offset (used by the timeline view). When
// `length` is given, the range is selected and briefly flashed.
export async function jumpToLocation(
	app: App,
	filePath: string,
	offset: number,
	length = 0
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(filePath);
	if (file instanceof TFile) await openAt(app, file, offset, length);
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
	const view = leaf.view;
	if (!(view instanceof MarkdownView)) return;
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
