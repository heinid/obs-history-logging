import { App, TFile } from "obsidian";
import { DecodedYear, EvMark } from "./types";
import { parseYearTag, yearTagRegex } from "./year-tag";
import { parseEvMarks, stripEvMarkers } from "./parser";
import { dedupe, trackMatches, tracksIn } from "./tracks";
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
	snippet: string; // trimmed source line, for search haystack
	block: string; // the surrounding paragraph, markdown-rendered in cards
	tagOrdinal: number; // 0-based index of this tag among identical tags in the block
	tracks: string[]; // #histolog/<track> classification; [] = untracked
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

// The whole paragraph (contiguous non-blank lines) around `index`, so the card
// can render list items / multi-line markdown, not just the tag's own line.
// Returns the block text and the char offset of its first line in `content`.
function blockAt(content: string, index: number): { text: string; start: number } {
	const lines = content.split("\n");
	const lineStart: number[] = [];
	let acc = 0;
	for (const ln of lines) {
		lineStart.push(acc);
		acc += ln.length + 1;
	}
	let cur = lines.length - 1;
	for (let i = 0; i < lines.length; i++) {
		if (index < lineStart[i] + lines[i].length + 1) {
			cur = i;
			break;
		}
	}
	let start = cur;
	while (start > 0 && lines[start - 1].trim() !== "" && !/^#{1,6}\s/.test(lines[start - 1]))
		start--;
	let end = cur;
	while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++;
	return {
		text: lines.slice(start, end + 1).join("\n").trim(),
		start: lineStart[start],
	};
}

// File-wide default tracks: track tags standing alone, i.e. in a block that
// contains no year tag (like a `#histolog/日本史` declaration line at the top).
// Track tags inside dated blocks only classify their own block.
function fileTracksOf(content: string): string[] {
	const names: string[] = [];
	for (const t of trackMatches(content)) {
		const block = blockAt(content, t.index);
		if (!yearTagRegex().test(block.text)) names.push(t.name);
	}
	return dedupe(names);
}

// 0-based index of the tag occurrence at `index` among identical year tags from
// `blockStart` up to it — so the expanded card can highlight the right one even
// when a paragraph repeats the same tag.
function tagOrdinal(
	content: string,
	blockStart: number,
	index: number,
	tag: string
): number {
	const slice = content.slice(blockStart, index);
	const re = yearTagRegex();
	let m: RegExpExecArray | null;
	let n = 0;
	while ((m = re.exec(slice)) !== null) if (m[0] === tag) n++;
	return n;
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
		const fileTracks = fileTracksOf(content);

		// Map char-offset of an event's inner tag -> its marker.
		const evTagIndex = new Map<number, EvMark>();
		for (const mark of parseEvMarks(content)) {
			evTagIndex.set(mark.index + mark.fullMatch.indexOf(mark.tag), mark);
		}

		const re = yearTagRegex();
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const decoded = parseYearTag(m[0]);
			if (!decoded) continue;
			const mark = evTagIndex.get(m.index);
			const block = blockAt(content, m.index);
			const blockTracks = tracksIn(block.text);
			// Track priority: bound inside the ev marker > elsewhere in the
			// block > the file-wide standalone default.
			const tracks =
				mark && mark.tracks.length > 0
					? mark.tracks
					: blockTracks.length > 0
						? blockTracks
						: fileTracks;
			entries.push({
				filePath: file.path,
				fileName: file.basename,
				line: lineOf(content, m.index),
				offset: m.index,
				tag: m[0],
				decoded,
				evId: mark?.id,
				summary: mark ? events.get(mark.id)?.summary : undefined,
				snippet: lineTextAt(content, m.index),
				block: stripEvMarkers(block.text),
				tagOrdinal: tagOrdinal(content, block.start, m.index, m[0]),
				tracks,
			});
		}
	}

	entries.sort(
		(a, b) => a.decoded.sortKey - b.decoded.sortKey || a.filePath.localeCompare(b.filePath)
	);
	return entries;
}
