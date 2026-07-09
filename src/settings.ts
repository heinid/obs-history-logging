import { App, PluginSettingTab, Setting } from "obsidian";
import type HistoryLoggingPlugin from "./main";

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
	// Language code preselected for new entity labels / readings.
	defaultLabelLang: string;
}

export const DEFAULT_SETTINGS: HistoryLoggingSettings = {
	dataFolder: "_chronology",
	hideTagsInPreview: true,
	fillEmptyPeriods: false,
	defaultLabelLang: "zh",
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
			.setName("Default entity language")
			.setDesc(
				"Language code preselected when adding labels / readings to an entity (e.g. zh, ja, en)."
			)
			.addText((text) =>
				text
					.setPlaceholder("zh")
					.setValue(this.plugin.settings.defaultLabelLang)
					.onChange(async (value) => {
						this.plugin.settings.defaultLabelLang = value.trim() || "zh";
						await this.plugin.saveSettings();
					})
			);
	}
}
