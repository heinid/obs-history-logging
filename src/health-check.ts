// "Check data health" command: scan the vault and the data files for the
// cross-reference problems the plugin's syntax can drift into — dead `{db …}`
// entity references, `{ev …}` markers pointing at missing events, orphan
// events.md entries whose marker was deleted from the notes, and duplicate
// entity ids — and show them in one report modal.

import { App, Modal, TFile } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { parseDbMarks } from "./db-marker";
import { parseEvMarks } from "./parser";
import { ENTITY_ID_RE } from "./db-format";

interface HealthIssue {
	kind: string;
	detail: string;
	location: string;
}

export async function checkDataHealth(
	plugin: HistoryLoggingPlugin
): Promise<void> {
	const { app, store } = plugin;
	const issues: HealthIssue[] = [];

	const entities = await store.readEntities();
	const events = await store.readEvents();

	// Duplicate entity ids collapse in the parsed Map; re-count the raw
	// headings to surface them.
	const entFile = app.vault.getAbstractFileByPath(store.entitiesFilePath());
	if (entFile instanceof TFile) {
		const raw = (await app.vault.read(entFile)).replace(/\r\n/g, "\n");
		const seen = new Map<string, number>();
		const re = /^##[ \t]+(.+?)[ \t]*$/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(raw)) !== null) {
			if (!ENTITY_ID_RE.test(m[1])) continue;
			seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
		}
		for (const [id, n] of seen)
			if (n > 1)
				issues.push({
					kind: "重复词条 id",
					detail: `id「${id}」出现 ${n} 次，后者覆盖前者`,
					location: "entities.md",
				});
	}

	const deadDb = (text: string, location: string): void => {
		for (const mark of parseDbMarks(text)) {
			if (!entities.has(mark.id))
				issues.push({
					kind: "死 {db} 引用",
					detail: `{db ${mark.id} ${mark.text}} 指向不存在的词条`,
					location,
				});
		}
	};

	// {db} references live in event summaries and entity notes.
	for (const [evId, ev] of events) deadDb(ev.summary, `events.md · ${evId}`);
	for (const [id, ent] of entities) deadDb(ent.body, `entities.md · ${id}`);

	// Vault notes: {ev} markers with no events.md entry, plus any inline
	// {db} references.
	const folderPrefix = plugin.settings.dataFolder.replace(/\/+$/, "") + "/";
	const usedEvIds = new Set<string>();
	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => !f.path.startsWith(folderPrefix));
	for (const file of files) {
		const content = (await app.vault.cachedRead(file)).replace(
			/\r\n/g,
			"\n"
		);
		deadDb(content, file.path);
		for (const mark of parseEvMarks(content)) {
			usedEvIds.add(mark.id);
			if (!events.has(mark.id))
				issues.push({
					kind: "死 {ev} 标记",
					detail: `{ev ${mark.id} ${mark.tag} } 在 events.md 中没有对应事件`,
					location: file.path,
				});
		}
	}

	// Orphan events: recorded in events.md but no marker anywhere in the vault.
	for (const [evId, ev] of events) {
		if (!usedEvIds.has(evId))
			issues.push({
				kind: "孤儿事件",
				detail: `事件 ${evId}（${ev.tag ?? "无 tag"}）在正文中已无 {ev} 标记`,
				location: "events.md",
			});
	}

	new HealthReportModal(app, issues, files.length).open();
}

class HealthReportModal extends Modal {
	constructor(
		app: App,
		private issues: HealthIssue[],
		private fileCount: number
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("数据健康检查");
		const { contentEl } = this;
		contentEl.addClass("hl-health-report");
		contentEl.createEl("p", {
			text: this.issues.length
				? `已扫描 ${this.fileCount} 个笔记文件，发现 ${this.issues.length} 个问题：`
				: `已扫描 ${this.fileCount} 个笔记文件，未发现问题。`,
		});
		if (!this.issues.length) return;
		const byKind = new Map<string, HealthIssue[]>();
		for (const i of this.issues) {
			const list = byKind.get(i.kind) ?? [];
			list.push(i);
			byKind.set(i.kind, list);
		}
		for (const [kind, list] of byKind) {
			contentEl.createEl("h4", { text: `${kind}（${list.length}）` });
			const ul = contentEl.createEl("ul");
			for (const i of list) {
				const li = ul.createEl("li");
				li.createSpan({ text: i.detail });
				li.createSpan({
					cls: "hl-health-loc",
					text: ` — ${i.location}`,
				});
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
