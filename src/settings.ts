import { App, PluginSettingTab, Setting } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { EvAction } from "./ev-actions";

export interface HistoryLoggingSettings {
	// Vault folder holding the plugin's markdown data files.
	dataFolder: string;
	// Hide non year classification tags (#histolog/…, other #tags) in the
	// collapsed timeline preview; they still appear when a card is expanded.
	hideTagsInPreview: boolean;
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
	// Successful scheduled recalls required before a quiz is archived.
	quizMasterySteps: number;
	// Delay after each non-final successful recall, in minutes
	// (day-scale steps: today → tomorrow → three days later).
	quizIntervalsMinutes: number[];
	// Wait after "forgot", in minutes; the card stays parked until then.
	quizRetryMinutes: number;
	// How long an overdue retry/recheck card keeps its own timeline slot
	// past the due time, in hours, before rejoining the shared slot.
	quizParkHours: number;
	// Optional first-learn recheck: a global notice fires this many minutes
	// after a new quiz is first remembered, and passing it completes step 1.
	quizRemindRecheck: boolean;
	quizRecheckMinutes: number;
	// Mask head years on quiz cards not already locked by an unmastered
	// year quiz; hover (or tap) to peek.
	quizHoverHideYears: boolean;
	// Immersive recall: every rendered `{db …}` reference on the timeline
	// starts hidden; left-click flips it, right-click picks a language.
	dbMaskMode: boolean;
	// Tags (without `#`) that enable entity features — `{db …}` rendering,
	// completion, clicking, masking — in ordinary vault notes. Empty list =
	// the features stay inside the plugin's own views only.
	dbEnableTags: string[];
	// After creating a new entity inline (即时新建), wrap the inserted marker
	// in `~={color|fn:id}…=~`, append `{;; id #tag }` at the line end and log
	// `id.date <ISO>` under the `<!-- annotations -->` block.
	annotOnCreate: boolean;
	// Highlight color inside `~={color|fn:id}`.
	annotColor: string;
	// Tag (without `#`) written inside the `{;; id #tag }` comment.
	annotTag: string;
	// Deck display mode in the recitation hub: card wall or compact list.
	reciteDeckDisplay: "wall" | "list";
}

export interface EvMenuView {
	kind: "profile" | "layout";
	name: string;
}

export const DEFAULT_SETTINGS: HistoryLoggingSettings = {
	dataFolder: "_chronology",
	hideTagsInPreview: true,
	entityLangs: ["ja", "zh", "en"],
	completeAutoTrigger: "normal",
	completeLastToken: true,
	wikiLang: "ja",
	evActions: [],
	evMenuViews: [],
	quizMasterySteps: 3,
	quizIntervalsMinutes: [24 * 60, 3 * 24 * 60],
	quizRetryMinutes: 10,
	quizParkHours: 24,
	quizRemindRecheck: false,
	quizRecheckMinutes: 10,
	quizHoverHideYears: false,
	dbMaskMode: false,
	dbEnableTags: [],
	annotOnCreate: false,
	annotColor: "green",
	annotTag: "专名和Entities积累",
	reciteDeckDisplay: "wall",
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
			.setName("管理后台")
			.setDesc("词条浏览、范畴管理等都在插件后台页面中。")
			.addButton((b) =>
				b
					.setButtonText("打开管理后台")
					.onClick(() => void this.plugin.browseEntities())
			);

		new Setting(containerEl)
			.setName("Quiz 学习阶段")
			.setDesc(
				"Quiz 只分为“在学”和“学过”。间隔表示最早可推进掌握的时间，不是截止时间。"
			)
			.setHeading();

		new Setting(containerEl)
			.setName("达到“学过”所需次数")
			.setDesc("按计划选择“记得”达到这个次数后，Quiz 进入“学过”。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "20";
				text
					.setValue(String(this.plugin.settings.quizMasterySteps))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20)
							return;
						this.plugin.settings.quizMasterySteps = parsed;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("记得后的间隔（天）")
			.setDesc(
				"每次选择“记得”后等待的天数，以逗号分隔。默认：1, 3（明天，然后三天后）。"
			)
			.addText((text) =>
				text
					.setPlaceholder("1, 3")
					.setValue(
						this.plugin.settings.quizIntervalsMinutes
							.map((m) => m / (24 * 60))
							.join(", ")
					)
					.onChange(async (value) => {
						const intervals = value
							.split(",")
							.map((part) => Number(part.trim()))
							.filter((n) => Number.isFinite(n) && n >= 0);
						if (!intervals.length) return;
						this.plugin.settings.quizIntervalsMinutes = intervals.map(
							(d) => Math.round(d * 24 * 60)
						);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("不记得后的等待（分钟）")
			.setDesc(
				"选择“不记得”后卡片进入等待，这些分钟后恢复可练，并弹出全局提醒。"
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text
					.setValue(String(this.plugin.settings.quizRetryMinutes))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed < 0) return;
						this.plugin.settings.quizRetryMinutes = parsed;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("分离卡位保持（小时）")
			.setDesc(
				"待重试/待重温的题在 Timeline 上分离成独立卡；到期后超过这些小时仍未作答，卡回归共享卡位。"
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text
					.setValue(String(this.plugin.settings.quizParkHours))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed < 0) return;
						this.plugin.settings.quizParkHours = parsed;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("新学后提醒重温")
			.setDesc(
				"开启后，新题第一次“记得”不直接推进，而是稍后弹出全局提醒重温一次，重温通过才完成第一步。"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.quizRemindRecheck)
					.onChange(async (value) => {
						this.plugin.settings.quizRemindRecheck = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("重温等待（分钟）")
			.setDesc("新学后到重温提醒之间的分钟数。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text
					.setValue(String(this.plugin.settings.quizRecheckMinutes))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed < 1) return;
						this.plugin.settings.quizRecheckMinutes = parsed;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Quiz 卡年份需悬停显示")
			.setDesc(
				"开启后，Quiz 卡头部的年份平时被遮住，悬停（移动端轻点）才显示。带未学过年份卡的事件始终遮住年份，不受此开关影响。"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.quizHoverHideYears)
					.onChange(async (value) => {
						this.plugin.settings.quizHoverHideYears = value;
						await this.plugin.saveSettings();
						await this.plugin.refreshTimelines();
					})
			);

		new Setting(containerEl)
			.setName("词条遮挡模式（沉浸记忆）")
			.setDesc(
				"开启后，Timeline 页面上所有词条引用默认遮住；左键揭开/遮住，遮住时右键选择以哪种语言揭开。也可用命令「切换词条遮挡模式」绑快捷键切换。"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dbMaskMode)
					.onChange(async (value) => {
						this.plugin.settings.dbMaskMode = value;
						await this.plugin.saveSettings();
						await this.plugin.refreshTimelines();
					})
			);

		new Setting(containerEl)
			.setName("启用词条功能的笔记标签")
			.setDesc(
				"带这些标签（frontmatter 或正文，逗号分隔，不带 #）的笔记中，{db} 词条会渲染、可点击，并启用输入补全与遮挡模式。留空则词条功能只在插件自己的页面中生效。嵌套标签也算（启用 history 同时匹配 history/rome）。"
			)
			.addText((text) =>
				text
					.setPlaceholder("history, 词条")
					.setValue(this.plugin.settings.dbEnableTags.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.dbEnableTags = value
							.split(",")
							.map((s) => s.trim().replace(/^#+/, ""))
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("即时新建词条后自动嵌套高亮批注")
			.setDesc(
				"在启用词条功能的笔记里即时新建词条后，自动把标记包进 ~={颜色|fn:id}…=~ 高亮、行尾追加 {;; id #tag }，并在文件底部 <!-- annotations --> 块记录 id.date 时间。"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.annotOnCreate)
					.onChange(async (value) => {
						this.plugin.settings.annotOnCreate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("批注高亮颜色")
			.setDesc("写进 ~={颜色|fn:id} 的颜色名。")
			.addText((text) =>
				text
					.setPlaceholder("green")
					.setValue(this.plugin.settings.annotColor)
					.onChange(async (value) => {
						this.plugin.settings.annotColor = value.trim() || "green";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("批注标签")
			.setDesc("写进行尾 {;; id #tag } 的标签（不带 #）。")
			.addText((text) =>
				text
					.setPlaceholder("专名和Entities积累")
					.setValue(this.plugin.settings.annotTag)
					.onChange(async (value) => {
						this.plugin.settings.annotTag = value.trim().replace(/^#+/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Entity languages")
			.setDesc(
				"Ordered, comma-separated language codes (e.g. zh, ja, en). The first available language is the entity's display name; language cards and completion follow the same order. New codes can also be added on an entity directly."
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
