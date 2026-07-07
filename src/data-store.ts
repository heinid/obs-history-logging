import { App, TFile, normalizePath } from "obsidian";
import { EventEntry } from "./types";
import { parseEventsFile, serializeEventsFile } from "./events-format";

// Reads / writes the markdown data files that live in the vault data folder.
export class DataStore {
	constructor(private app: App, private getFolder: () => string) {}

	private eventsPath(): string {
		return normalizePath(`${this.getFolder()}/events.md`);
	}

	private async ensureFolder(): Promise<void> {
		const folder = normalizePath(this.getFolder());
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {
				/* already exists / race */
			});
		}
	}

	async readEvents(): Promise<Map<string, EventEntry>> {
		const file = this.app.vault.getAbstractFileByPath(this.eventsPath());
		if (!(file instanceof TFile)) return new Map();
		const content = await this.app.vault.read(file);
		return parseEventsFile(content);
	}

	async writeEvents(entries: Map<string, EventEntry>): Promise<void> {
		await this.ensureFolder();
		const content = serializeEventsFile(entries);
		const path = this.eventsPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	async getEvent(id: string): Promise<EventEntry | undefined> {
		return (await this.readEvents()).get(id);
	}

	async upsertEvent(entry: EventEntry): Promise<void> {
		const entries = await this.readEvents();
		entries.set(entry.id, {
			...entry,
			updated: entry.updated ?? new Date().toISOString().slice(0, 10),
		});
		await this.writeEvents(entries);
	}

	async removeEvent(id: string): Promise<void> {
		const entries = await this.readEvents();
		if (entries.delete(id)) await this.writeEvents(entries);
	}
}
