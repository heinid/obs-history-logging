import { App, Modal, Setting } from "obsidian";

// Minimal single-field prompt, used e.g. to name a saved view.
export class NameModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private initial: string,
		private onSubmit: (name: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		let value = this.initial;
		const submit = () => {
			const name = value.trim();
			if (!name) return;
			this.close();
			this.onSubmit(name);
		};
		new Setting(this.contentEl).setName("Name").addText((t) => {
			t.setValue(value).onChange((v) => (value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Save").setCta().onClick(submit)
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Minimal confirmation prompt for destructive actions.
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private body: string,
		private confirmText: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("取消").onClick(() => this.close())
			)
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Confirmation with several explicit outcomes (e.g. save / archive / cancel).
export class ChoiceModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private body: string,
		private choices: { text: string; cta?: boolean; onPick?: () => void }[]
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.body });
		const row = new Setting(this.contentEl);
		for (const c of this.choices)
			row.addButton((b) => {
				b.setButtonText(c.text).onClick(() => {
					this.close();
					c.onPick?.();
				});
				if (c.cta) b.setCta();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
