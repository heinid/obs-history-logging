import { Editor, Notice } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { generateId } from "./id";
import { evIdsIn } from "./parser";
import { YEAR_TAG_SRC } from "./year-tag";

const TAG_TOKEN_RE = new RegExp(YEAR_TAG_SRC, "g");

// Find the year tag whose span contains the cursor column, if any.
function tagAtCursor(
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
