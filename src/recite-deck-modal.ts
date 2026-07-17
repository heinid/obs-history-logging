import { App, Modal, Notice, Setting } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { ReciteDeck } from "./recite-format";
import { langDisplayName } from "./quiz-render";

// Create / edit an entity-recitation direction deck. `remove` is true when the
// user deletes an existing deck.
export class ReciteDeckModal extends Modal {
	private draft: ReciteDeck;

	constructor(
		app: App,
		private plugin: HistoryLoggingPlugin,
		private existing: ReciteDeck | null,
		private onSubmit: (deck: ReciteDeck, remove: boolean) => Promise<void>
	) {
		super(app);
		this.draft = existing
			? { ...existing, to: [...existing.to], tags: [...existing.tags], types: [...existing.types] }
			: { name: "", from: "", to: [], tags: [], types: [] };
	}

	onOpen(): void {
		this.titleEl.setText(this.existing ? "编辑背诵方向" : "新建背诵方向");
		const langs = this.plugin.settings.entityLangs;

		new Setting(this.contentEl).setName("名称").addText((t) =>
			t
				.setValue(this.draft.name)
				.setPlaceholder("如：日本史 · 中→日")
				.onChange((v) => (this.draft.name = v))
		);

		new Setting(this.contentEl)
			.setName("出发语言")
			.setDesc("显示这个语言的词形")
			.addDropdown((d) => {
				d.addOption("", "选择…");
				for (const l of langs) d.addOption(l, langDisplayName(l));
				d.setValue(this.draft.from);
				d.onChange((v) => (this.draft.from = v));
			});

		this.contentEl.createEl("div", {
			cls: "setting-item-name",
			text: "目标语言（要回忆的，可多选）",
		});
		for (const l of langs) {
			new Setting(this.contentEl)
				.setName(langDisplayName(l))
				.addToggle((tg) =>
					tg
						.setValue(this.draft.to.includes(l))
						.onChange((on) => {
							if (on) {
								if (!this.draft.to.includes(l))
									this.draft.to.push(l);
							} else
								this.draft.to = this.draft.to.filter(
									(x) => x !== l
								);
						})
				);
		}

		new Setting(this.contentEl)
			.setName("限定标签")
			.setDesc("逗号分隔，留空表示不限（词条 tag，命中嵌套子标签）")
			.addText((t) =>
				t
					.setValue(this.draft.tags.join(", "))
					.setPlaceholder("日本史, 政权")
					.onChange(
						(v) =>
							(this.draft.tags = v
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean))
					)
			);

		new Setting(this.contentEl)
			.setName("限定类型")
			.setDesc("逗号分隔，留空表示不限（词条 type）")
			.addText((t) =>
				t
					.setValue(this.draft.types.join(", "))
					.setPlaceholder("person, polity")
					.onChange(
						(v) =>
							(this.draft.types = v
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean))
					)
			);

		const actions = new Setting(this.contentEl);
		if (this.existing)
			actions.addButton((b) =>
				b
					.setButtonText("删除")
					.setWarning()
					.onClick(() => void this.submit(true))
			);
		actions.addButton((b) =>
			b
				.setButtonText("保存")
				.setCta()
				.onClick(() => void this.submit(false))
		);
	}

	private async submit(remove: boolean): Promise<void> {
		if (!remove) {
			this.draft.name = this.draft.name.trim();
			if (!this.draft.name) {
				new Notice("请填写名称");
				return;
			}
			if (!this.draft.from) {
				new Notice("请选择出发语言");
				return;
			}
			if (!this.draft.to.length) {
				new Notice("请至少选择一个目标语言");
				return;
			}
		}
		this.close();
		await this.onSubmit(this.draft, remove);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
