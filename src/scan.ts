import { App, TFile } from "obsidian";
import { DecodedYear } from "./types";
import { parseYearTag, yearTagRegex } from "./year-tag";
import { parseEvMarks } from "./parser";
import { DataStore } from "./data-store";

// One occurrence of a year tag in the vault, decoded and enriched with its
// optional event id / summary. The timeline is built purely from these — a
// bare tag needs no id to appear.
export interface TimelineEntry {
	filePath: string;
	fileName: string;
	line: number; // 0-based
	offset: number; // char offset (LF-normalised) for jump-to-source
	tag: string;
	decoded: DecodedYear;
	evId?: string;
	summary?: string;
	snippet: string; // trimmed source line for context
}

function lineOf(content: string, index: number): number {
	let line = 0;
	for (let i = 0; i < index && i < content.length; i++) {
		if (content[i] === "\n") line++;
	}
	return line;
}

function lineTextAt(content: string, index: number): string {
	const start = content.lastIndexOf("\n", index - 1) + 1;
	let end = content.indexOf("\n", index);
	if (end === -1) end = content.length;
	return content.slice(start, end).trim();
}

// Scan every markdown file (excluding the data folder) for year tags.
export async function scanVault(
	app: App,
	store: DataStore,
	dataFolder: string
): Promise<TimelineEntry[]> {
	const events = await store.readEvents();
	const entries: TimelineEntry[] = [];
	const folderPrefix = dataFolder.replace(/\/+$/, "") + "/";

	const files = app.vault
		.getMarkdownFiles()
		.filter((f: TFile) => !f.path.startsWith(folderPrefix));

	for (const file of files) {
		const content = (await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");

		// Map char-offset of an event's inner tag -> its id.
		const evTagIndex = new Map<number, string>();
		for (const mark of parseEvMarks(content)) {
			evTagIndex.set(mark.index + mark.fullMatch.indexOf(mark.tag), mark.id);
		}

		const re = yearTagRegex();
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const decoded = parseYearTag(m[0]);
			if (!decoded) continue;
			const evId = evTagIndex.get(m.index);
			entries.push({
				filePath: file.path,
				fileName: file.basename,
				line: lineOf(content, m.index),
				offset: m.index,
				tag: m[0],
				decoded,
				evId,
				summary: evId ? events.get(evId)?.summary : undefined,
				snippet: lineTextAt(content, m.index),
			});
		}
	}

	entries.sort(
		(a, b) => a.decoded.sortKey - b.decoded.sortKey || a.filePath.localeCompare(b.filePath)
	);
	return entries;
}
