import { App, PluginSettingTab, Setting } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EvAction } from "./ev-actions";

export interface HistoryLoggingSettings {
	// Vault folder holding the plugin's markdown data files.
	dataFolder: string;
	// Hide non year classification tags (#histolog/…, other #tags) in the
	// collapsed timeline preview; they still appear when a card is expanded.
	hideTagsInPreview: boolean;
	// Single-track view: also render empty century/decade sections so the
	// timeline's vertical extent stays proportional to real time (the
	// multi-track grid always does this). Off = compact, events only.
	fillEmptyPeriods: boolean;
	// Ordered preset language codes for entity language cards; the first is
	// the default for new entries.
	entityLangs: string[];
	// How the entity completion dropdown fires while typing (the explicit
	// `//` trigger always works): "normal" = CJK 1 char / Latin 2,
	// "conservative" = CJK 2 / Latin 3, "off" = only `//`.
	completeAutoTrigger: "normal" | "conservative" | "off";
	// Also auto-complete on the last word of a spaced (Latin-script) name —
	// typing just the surname finds the full-name entry.
	completeLastToken: boolean;
	// Wikipedia language edition for the ⌛ menu's year-page item.
	wikiLang: string;
	// User-defined ⌛ menu actions (name + URL template).
	evActions: EvAction[];
	// Curated timeline views for the ⌛ menu's "Show on timeline with…"
	// submenu: a saved single-track profile or a saved multi-track layout.
	evMenuViews: EvMenuView[];
}

export interface EvMenuView {
	kind: "profile" | "layout";
	name: string;
}

export const DEFAULT_SETTINGS: HistoryLoggingSettings = {
	dataFolder: "_chronology",
	hideTagsInPreview: true,
	fillEmptyPeriods: false,
	entityLangs: ["ja", "zh", "en"],
	completeAutoTrigger: "normal",
	completeLastToken: true,
	wikiLang: "ja",
	evActions: [],
	evMenuViews: [],
};

export const EVENTS_FILE = "events.md";

export class HistoryLoggingSettingTab extends PluginSettingTab {
	plugin: HistoryLoggingPlugin;

	constructor(app: App, plugin: HistoryLoggingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Data folder")
			.setDesc(
				"Vault folder where events, eras and profiles are stored as markdown files."
			)
			.addText((text) =>
				text
					.setPlaceholder("_chronology")
					.setValue(this.plugin.settings.dataFolder)
					.onChange(async (value) => {
						this.plugin.settings.dataFolder =
							value.trim().replace(/^\/+|\/+$/g, "") || "_chronology";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hide tags in collapsed preview")
			.setDesc(
				"Hide classification / non year tags in the collapsed timeline card. They still show when the card is expanded."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideTagsInPreview)
					.onChange(async (value) => {
						this.plugin.settings.hideTagsInPreview = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show empty periods in single-track view")
			.setDesc(
				"Also render centuries/decades that contain no events, so the timeline's length stays proportional to real time (the era-system coverage when a lens is set, otherwise the span between the first and last event). The multi-track grid always shows them. Off = compact list with event periods only."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fillEmptyPeriods)
					.onChange(async (value) => {
						this.plugin.settings.fillEmptyPeriods = value;
						await this.plugin.saveSettings();
						await this.plugin.refreshTimelines();
					})
			);

		new Setting(containerEl)
			.setName("管理后台")
			.setDesc("词条浏览、范畴管理等都在插件后台页面中。")
			.addButton((b) =>
				b
					.setButtonText("打开管理后台")
					.onClick(() => void this.plugin.browseEntities())
			);

		new Setting(containerEl)
			.setName("Entity languages")
			.setDesc(
				"Ordered, comma-separated language codes for entity language cards (e.g. ja, zh, en). New codes can also be added on an entity directly."
			)
			.addText((text) =>
				text
					.setPlaceholder("ja, zh, en")
					.setValue(this.plugin.settings.entityLangs.join(", "))
					.onChange(async (value) => {
						const langs = value
							.split(",")
							.map((s) => s.trim().toLowerCase())
							.filter((s) => s.length > 0);
						this.plugin.settings.entityLangs = langs.length
							? langs
							: ["ja", "zh", "en"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Entity completion while typing")
			.setDesc(
				"When the completion dropdown opens as you type. The explicit // trigger (type two slashes, then a fragment) always works. Normal: 1 CJK char / 2 Latin letters. Conservative: 2 CJK chars / 3 Latin letters. Off: only //."
			)
			.addDropdown((d) =>
				d
					.addOption("normal", "Normal")
					.addOption("conservative", "Conservative")
					.addOption("off", "Only //")
					.setValue(this.plugin.settings.completeAutoTrigger)
					.onChange(async (value) => {
						this.plugin.settings.completeAutoTrigger =
							value as "normal" | "conservative" | "off";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Complete on surname")
			.setDesc(
				"For spaced names (e.g. Gaius Julius Caesar), typing just the last word (Caesar) also finds the entry."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.completeLastToken)
					.onChange(async (value) => {
						this.plugin.settings.completeLastToken = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Wikipedia language")
			.setDesc(
				"Wikipedia edition opened by the ⌛ menu's year-page item (e.g. ja, zh, en)."
			)
			.addText((text) =>
				text
					.setPlaceholder("ja")
					.setValue(this.plugin.settings.wikiLang)
					.onChange(async (value) => {
						this.plugin.settings.wikiLang =
							value.trim().toLowerCase() || "ja";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom ⌛ menu actions")
			.setDesc(
				"Extra menu items for the event marker. Each action opens a URL built from its template; placeholders: {year} (signed number, BC negative), {tag}, {track}."
			)
			.setHeading();

		this.plugin.settings.evActions.forEach((action, i) => {
			const row = new Setting(containerEl);
			row.addText((t) =>
				t
					.setPlaceholder("Name")
					.setValue(action.name)
					.onChange(async (v) => {
						action.name = v.trim();
						await this.plugin.saveSettings();
					})
			);
			row.addText((t) => {
				t.setPlaceholder("https://…/{year}…")
					.setValue(action.url)
					.onChange(async (v) => {
						action.url = v.trim();
						await this.plugin.saveSettings();
					});
				t.inputEl.addClass("hl-action-url");
			});
			row.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Remove action")
					.onClick(async () => {
						this.plugin.settings.evActions.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
					})
			);
		});

		new Setting(containerEl).addButton((b) =>
			b.setButtonText("+ action").onClick(async () => {
				this.plugin.settings.evActions.push({ name: "", url: "" });
				await this.plugin.saveSettings();
				this.display();
			})
		);

		new Setting(containerEl)
			.setName("⌛ menu timeline views")
			.setDesc(
				"Saved profiles or layouts added here appear under the ⌛ menu's \"Show on timeline with…\" submenu. Leave empty to hide the submenu."
			)
			.setHeading();
		const viewsEl = containerEl.createDiv();
		void this.renderEvMenuViews(viewsEl);
	}

	private async renderEvMenuViews(host: HTMLElement): Promise<void> {
		const [profiles, layouts] = await Promise.all([
			this.plugin.store.readProfiles(),
			this.plugin.store.readLayouts(),
		]);
		host.empty();
		const views = this.plugin.settings.evMenuViews;
		views.forEach((v, i) => {
			new Setting(host)
				.setName(v.name)
				.setDesc(v.kind === "profile" ? "Profile" : "Layout")
				.addExtraButton((b) =>
					b
						.setIcon("trash")
						.setTooltip("Remove")
						.onClick(async () => {
							views.splice(i, 1);
							await this.plugin.saveSettings();
							void this.renderEvMenuViews(host);
						})
				);
		});
		const candidates: EvMenuView[] = [
			...profiles.map((p): EvMenuView => ({ kind: "profile", name: p.name })),
			...layouts.map((l): EvMenuView => ({ kind: "layout", name: l.name })),
		].filter(
			(c) => !views.some((v) => v.kind === c.kind && v.name === c.name)
		);
		if (!candidates.length) {
			if (!views.length)
				host.createDiv({
					cls: "setting-item-description",
					text: "No saved profiles or layouts yet.",
				});
			return;
		}
		let picked = 0;
		new Setting(host)
			.addDropdown((d) => {
				candidates.forEach((c, i) =>
					d.addOption(
						String(i),
						`${c.name} (${c.kind === "profile" ? "profile" : "layout"})`
					)
				);
				d.setValue("0").onChange((v) => (picked = Number(v)));
			})
			.addButton((b) =>
				b.setButtonText("+ add").onClick(async () => {
					views.push(candidates[picked]);
					await this.plugin.saveSettings();
					void this.renderEvMenuViews(host);
				})
			);
	}
}
