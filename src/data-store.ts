import { App, TFile, normalizePath } from "obsidian";
import { EventEntry } from "./types";
import { parseEventsFile, serializeEventsFile } from "./events-format";
import {
	DEFAULT_PROFILE,
	Profile,
	parseProfilesFile,
	serializeProfilesFile,
} from "./profiles";
import { EraSystem, parseErasFile, serializeErasFile } from "./eras";
import {
	TimelineLayout,
	parseLayoutsFile,
	serializeLayoutsFile,
} from "./layouts";
import {
	DbType,
	DEFAULT_DB_TYPES,
	EntityEntry,
	parseDbTypesFile,
	parseEntitiesFile,
	serializeDbTypesFile,
	serializeEntitiesFile,
} from "./db-format";

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

	private profilesPath(): string {
		return normalizePath(`${this.getFolder()}/profiles.md`);
	}

	async readProfiles(): Promise<Profile[]> {
		const file = this.app.vault.getAbstractFileByPath(this.profilesPath());
		if (!(file instanceof TFile)) return [DEFAULT_PROFILE];
		return parseProfilesFile(await this.app.vault.read(file));
	}

	private erasPath(): string {
		return normalizePath(`${this.getFolder()}/eras.md`);
	}

	async readEraSystems(): Promise<EraSystem[]> {
		const file = this.app.vault.getAbstractFileByPath(this.erasPath());
		if (!(file instanceof TFile)) return [];
		return parseErasFile(await this.app.vault.read(file));
	}

	async writeEraSystems(systems: EraSystem[]): Promise<void> {
		await this.ensureFolder();
		const content = serializeErasFile(systems);
		const path = this.erasPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	private layoutsPath(): string {
		return normalizePath(`${this.getFolder()}/layouts.md`);
	}

	async readLayouts(): Promise<TimelineLayout[]> {
		const file = this.app.vault.getAbstractFileByPath(this.layoutsPath());
		if (!(file instanceof TFile)) return [];
		return parseLayoutsFile(await this.app.vault.read(file));
	}

	async writeLayouts(layouts: TimelineLayout[]): Promise<void> {
		await this.ensureFolder();
		const content = serializeLayoutsFile(layouts);
		const path = this.layoutsPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	private entitiesPath(): string {
		return normalizePath(`${this.getFolder()}/entities.md`);
	}

	async readEntities(): Promise<Map<string, EntityEntry>> {
		const file = this.app.vault.getAbstractFileByPath(this.entitiesPath());
		if (!(file instanceof TFile)) return new Map();
		return parseEntitiesFile(await this.app.vault.read(file));
	}

	async writeEntities(entries: Map<string, EntityEntry>): Promise<void> {
		await this.ensureFolder();
		const content = serializeEntitiesFile(entries);
		const path = this.entitiesPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	async upsertEntity(entry: EntityEntry): Promise<void> {
		const entries = await this.readEntities();
		entries.set(entry.id, {
			...entry,
			updated: new Date().toISOString().slice(0, 10),
		});
		await this.writeEntities(entries);
	}

	async removeEntity(id: string): Promise<void> {
		const entries = await this.readEntities();
		if (entries.delete(id)) await this.writeEntities(entries);
	}

	private dbTypesPath(): string {
		return normalizePath(`${this.getFolder()}/db-types.md`);
	}

	async readDbTypes(): Promise<DbType[]> {
		const file = this.app.vault.getAbstractFileByPath(this.dbTypesPath());
		if (!(file instanceof TFile)) return [...DEFAULT_DB_TYPES];
		const types = parseDbTypesFile(await this.app.vault.read(file));
		return types.length ? types : [...DEFAULT_DB_TYPES];
	}

	async writeDbTypes(types: DbType[]): Promise<void> {
		await this.ensureFolder();
		const content = serializeDbTypesFile(types);
		const path = this.dbTypesPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	async writeProfiles(profiles: Profile[]): Promise<void> {
		await this.ensureFolder();
		const content = serializeProfilesFile(profiles);
		const path = this.profilesPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}
}
