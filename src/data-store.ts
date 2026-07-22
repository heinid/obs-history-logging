import { App, Notice, TFile, normalizePath } from "obsidian";
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
import { QuizEntry } from "./quiz";
import { parseQuizzesFile, serializeQuizzesFile } from "./quizzes-format";
import {
	ReciteDeck,
	parseReciteDecksFile,
	serializeReciteDecksFile,
} from "./recite-format";
import { MapEntry, parseMapsFile, serializeMapsFile } from "./maps-format";
import {
	ReciteView,
	parseReciteViewsFile,
	serializeReciteViewsFile,
	viewFromDeck,
} from "./recite-views";
import {
	ReciteProgress,
	keyOf,
	parseReciteProgressFile,
	serializeReciteProgressFile,
} from "./recite-progress";
import {
	QuizView,
	parseQuizViewsFile,
	serializeQuizViewsFile,
} from "./quiz-views";

// Reads / writes the markdown data files that live in the vault data folder.
export class DataStore {
	private warned = new Set<string>();

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

	private quizzesPath(): string {
		return normalizePath(`${this.getFolder()}/quizzes.md`);
	}

	quizzesFilePath(): string {
		return this.quizzesPath();
	}

	async readQuizzes(): Promise<Map<string, QuizEntry>> {
		const file = this.app.vault.getAbstractFileByPath(this.quizzesPath());
		if (!(file instanceof TFile)) return new Map();
		return parseQuizzesFile(await this.app.vault.read(file));
	}

	async writeQuizzes(quizzes: Map<string, QuizEntry>): Promise<void> {
		await this.ensureFolder();
		const content = serializeQuizzesFile(quizzes);
		const path = this.quizzesPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	async upsertQuiz(quiz: QuizEntry): Promise<void> {
		const quizzes = await this.readQuizzes();
		quizzes.set(quiz.id, quiz);
		await this.writeQuizzes(quizzes);
	}

	async removeQuiz(id: string): Promise<void> {
		const quizzes = await this.readQuizzes();
		if (quizzes.delete(id)) await this.writeQuizzes(quizzes);
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

	entitiesFilePath(): string {
		return this.entitiesPath();
	}

	async readEntities(): Promise<Map<string, EntityEntry>> {
		const file = this.app.vault.getAbstractFileByPath(this.entitiesPath());
		if (!(file instanceof TFile)) return new Map();
		return parseEntitiesFile(await this.app.vault.read(file), (msg) => {
			if (this.warned.has(msg)) return;
			this.warned.add(msg);
			new Notice(msg, 8000);
		});
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
		const today = new Date().toISOString().slice(0, 10);
		entries.set(entry.id, {
			...entry,
			created:
				entry.created ??
				entries.get(entry.id)?.created ??
				today,
			updated: today,
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

	private mapsPath(): string {
		return normalizePath(`${this.getFolder()}/maps.md`);
	}

	mapsFilePath(): string {
		return this.mapsPath();
	}

	async readMaps(): Promise<Map<string, MapEntry>> {
		const file = this.app.vault.getAbstractFileByPath(this.mapsPath());
		if (!(file instanceof TFile)) return new Map();
		return parseMapsFile(await this.app.vault.read(file));
	}

	async writeMaps(entries: Map<string, MapEntry>): Promise<void> {
		await this.ensureFolder();
		const content = serializeMapsFile(entries);
		const path = this.mapsPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	async upsertMap(entry: MapEntry): Promise<void> {
		const entries = await this.readMaps();
		entries.set(entry.id, {
			...entry,
			updated: new Date().toISOString().slice(0, 10),
		});
		await this.writeMaps(entries);
	}

	async removeMap(id: string): Promise<void> {
		const entries = await this.readMaps();
		if (entries.delete(id)) await this.writeMaps(entries);
	}

	private reciteDecksPath(): string {
		return normalizePath(`${this.getFolder()}/recite-decks.md`);
	}

	async readReciteDecks(): Promise<ReciteDeck[]> {
		const file = this.app.vault.getAbstractFileByPath(
			this.reciteDecksPath()
		);
		if (!(file instanceof TFile)) return [];
		return parseReciteDecksFile(await this.app.vault.read(file));
	}

	async writeReciteDecks(decks: ReciteDeck[]): Promise<void> {
		await this.ensureFolder();
		const content = serializeReciteDecksFile(decks);
		const path = this.reciteDecksPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	private reciteViewsPath(): string {
		return normalizePath(`${this.getFolder()}/recite-views.md`);
	}

	// Views supersede the old direction decks; the first read migrates
	// recite-decks.md entries when no views file exists yet.
	async readReciteViews(): Promise<ReciteView[]> {
		const file = this.app.vault.getAbstractFileByPath(
			this.reciteViewsPath()
		);
		if (file instanceof TFile)
			return parseReciteViewsFile(await this.app.vault.read(file));
		const decks = await this.readReciteDecks();
		if (!decks.length) return [];
		const views = decks.map(viewFromDeck);
		await this.writeReciteViews(views);
		return views;
	}

	async writeReciteViews(views: ReciteView[]): Promise<void> {
		await this.ensureFolder();
		const content = serializeReciteViewsFile(views);
		const path = this.reciteViewsPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	private quizViewsPath(): string {
		return normalizePath(`${this.getFolder()}/quiz-views.md`);
	}

	async readQuizViews(): Promise<QuizView[]> {
		const file = this.app.vault.getAbstractFileByPath(
			this.quizViewsPath()
		);
		if (!(file instanceof TFile)) return [];
		return parseQuizViewsFile(await this.app.vault.read(file));
	}

	async writeQuizViews(views: QuizView[]): Promise<void> {
		await this.ensureFolder();
		const content = serializeQuizViewsFile(views);
		const path = this.quizViewsPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	private reciteProgressPath(): string {
		return normalizePath(`${this.getFolder()}/recite-progress.md`);
	}

	async readReciteProgress(): Promise<Map<string, ReciteProgress>> {
		const file = this.app.vault.getAbstractFileByPath(
			this.reciteProgressPath()
		);
		if (!(file instanceof TFile)) return new Map();
		return parseReciteProgressFile(await this.app.vault.read(file));
	}

	async writeReciteProgress(
		records: Map<string, ReciteProgress>
	): Promise<void> {
		await this.ensureFolder();
		const content = serializeReciteProgressFile(records);
		const path = this.reciteProgressPath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}

	async upsertReciteProgress(records: ReciteProgress[]): Promise<void> {
		if (!records.length) return;
		const all = await this.readReciteProgress();
		for (const rec of records) all.set(keyOf(rec), rec);
		await this.writeReciteProgress(all);
	}

	async deleteReciteProgress(keys: string[]): Promise<void> {
		if (!keys.length) return;
		const all = await this.readReciteProgress();
		for (const key of keys) all.delete(key);
		await this.writeReciteProgress(all);
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
