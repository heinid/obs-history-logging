import { Editor, Notice, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { generateId } from "./id";
import { evIdsIn, wrapTagAt } from "./parser";
import { YEAR_TAG_SRC } from "./year-tag";
import type { TimelineEntry } from "./scan";

const TAG_TOKEN_RE = new RegExp(YEAR_TAG_SRC, "g");

// Find the year tag whose span contains the cursor column, if any.
export function tagAtCursor(
	line: string,
	ch: number
): { tag: string; from: number; to: number } | null {
	TAG_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TAG_TOKEN_RE.exec(line)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (ch >= from && ch <= to) return { tag: m[0], from, to };
	}
	return null;
}

// Wrap the year tag under the cursor into `{ev <id> #tag }`, then open the
// summary editor for the new event.
export async function addEventAtCursor(
	plugin: HistoryLoggingPlugin,
	editor: Editor
): Promise<void> {
	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);
	const hit = tagAtCursor(line, cursor.ch);
	if (!hit) {
		new Notice("Place the cursor on a #ad / #bc year tag first");
		return;
	}

	// Already wrapped? Just open the existing event.
	const before = line.slice(0, hit.from);
	if (/\{ev\s+[0-9a-z]{8}\s+$/.test(before)) {
		const idMatch = /\{ev\s+([0-9a-z]{8})\s+$/.exec(before);
		if (idMatch) {
			plugin.openSummary(idMatch[1], hit.tag);
			return;
		}
	}

	const taken = evIdsIn(editor.getValue());
	const id = generateId((candidate) => taken.has(candidate));

	editor.replaceRange(
		`{ev ${id} ${hit.tag} }`,
		{ line: cursor.line, ch: hit.from },
		{ line: cursor.line, ch: hit.to }
	);

	plugin.openSummary(id, hit.tag);
}

// Add or edit the summary for a timeline entry, straight from the timeline.
// A bare tag is wrapped into `{ev <id> #tag }` in its source note at the known
// offset first; an already-bound tag just opens its existing summary.
// `onWrapped` fires once the source note changes (a rescan is needed);
// `onSaved` fires on every summary save (a single-card repaint suffices).
export async function addEventForEntry(
	plugin: HistoryLoggingPlugin,
	entry: TimelineEntry,
	onWrapped?: () => void,
	onSaved?: (evId: string, summary: string) => void
): Promise<void> {
	if (entry.evId) {
		const evId = entry.evId;
		plugin.openSummary(evId, entry.tag, (s) => onSaved?.(evId, s));
		return;
	}
	await addEventForTag(
		plugin,
		entry.filePath,
		entry.offset,
		entry.tag,
		onWrapped,
		onSaved
	);
}

// Open the summary editor for a bare year tag at a known offset in a note.
// Deferred creation: nothing is written to the source note until the summary
// actually gets content, so opening the editor and closing it empty leaves
// no trace.
export async function addEventForTag(
	plugin: HistoryLoggingPlugin,
	filePath: string,
	offset: number,
	tag: string,
	onWrapped?: () => void,
	onSaved?: (evId: string, summary: string) => void
): Promise<void> {
	const prepared = await prepareEventForTag(
		plugin,
		filePath,
		offset,
		tag,
		onWrapped
	);
	if (!prepared) return;
	plugin.openSummary(
		prepared.id,
		tag,
		(s) => onSaved?.(prepared.id, s),
		prepared.ensure
	);
}

export async function prepareEventForTag(
	plugin: HistoryLoggingPlugin,
	filePath: string,
	offset: number,
	tag: string,
	onWrapped?: () => void
): Promise<{ id: string; ensure: () => Promise<boolean> } | null> {
	const file = plugin.app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) {
		new Notice("Could not find the source note");
		return null;
	}

	const content = (await plugin.app.vault.read(file)).replace(/\r\n/g, "\n");
	const id = generateId((c) => evIdsIn(content).has(c));

	const ensure = async (): Promise<boolean> => {
		const cur = (await plugin.app.vault.read(file)).replace(/\r\n/g, "\n");
		const next = wrapTagAt(cur, offset, offset + tag.length, id);
		if (next === null) {
			new Notice("Could not add an event to this tag");
			return false;
		}
		await plugin.app.vault.modify(file, next);
		onWrapped?.();
		return true;
	};
	return { id, ensure };
}
