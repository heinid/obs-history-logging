import { App, MarkdownView, TFile } from "obsidian";

// Locate an inline `{ev <id> ...}` marker anywhere in the vault and open the
// note at that position. The id is globally unique, so a plain scan suffices;
// no Obsidian block-id is required.
export async function jumpToEv(app: App, id: string): Promise<boolean> {
	const needle = `{ev ${id} `;
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		const content = (await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");
		const idx = content.indexOf(needle);
		if (idx === -1) continue;
		await openAt(app, file, idx);
		return true;
	}
	return false;
}

async function openAt(app: App, file: TFile, offset: number): Promise<void> {
	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file);
	const view = leaf.view;
	if (view instanceof MarkdownView) {
		const editor = view.editor;
		const pos = editor.offsetToPos(offset);
		editor.setCursor(pos);
		editor.scrollIntoView({ from: pos, to: pos }, true);
	}
}
