import { App, MarkdownView, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { evLocationIndex } from "./scan";
import { flashJumpTarget } from "./jump-flash";

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
	// Pass the target line as the ephemeral state of the open itself, so
	// Obsidian scrolls there instead of restoring the file's remembered
	// scroll position (which would otherwise yank the view away afterwards).
	const content = (await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");
	const line = content.slice(0, offset).split("\n").length - 1;
	await leaf.openFile(file, { eState: { line } });
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
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	if (cm) flashJumpTarget(cm, offset, offset + length);
	// Something (scroll-position restore, layout shifts from decorations
	// unfolding, deferred rendering of long documents) can still yank the
	// view away from the target moments after we scrolled to it. Instead of
	// racing it with fixed delays, watch the target for a short while and
	// re-scroll whenever it leaves the viewport.
	if (cm) {
		const deadline = Date.now() + 2500;
		const tick = (): void => {
			const rect = cm.scrollDOM.getBoundingClientRect();
			const coords = cm.coordsAtPos(Math.min(offset, cm.state.doc.length));
			if (!coords || coords.top < rect.top || coords.bottom > rect.bottom)
				editor.scrollIntoView({ from, to }, true);
			if (Date.now() < deadline) window.setTimeout(tick, 100);
		};
		window.setTimeout(tick, 100);
	}
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


