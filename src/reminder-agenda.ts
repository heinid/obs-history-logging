import { App, Modal, setIcon } from "obsidian";
import type HistoryLoggingPlugin from "./main";
import { QuizEntry, isQuizParked, isQuizWaiting } from "./quiz";
import { quizQuestion, quizSchedule } from "./quiz-display";
import { langDisplayName } from "./quiz-render";
import { toQuizShape } from "./recite-progress";

// One agenda over both short-wait pipelines: quizzes and lexicon directions
// sitting out a retry/recheck wait (or already past it), plus one-shot
// «延后查背» records. Rows group into due-now and still-waiting; clicking a
// row opens the matching reminder card.

interface AgendaItem {
	kind: "quiz" | "recite";
	id: string; // quiz id or progress key
	title: string;
	tag: string; // small descriptor: quiz kind or direction
	due: number; // epoch ms
	ephemeral: boolean;
}

const QUIZ_KIND_LABELS: Record<string, string> = {
	year: "年份",
	cloze: "填空",
	qa: "问答",
	map: "地图",
};

function inShortPipeline(shape: QuizEntry, now: Date, due: number, schedule: ReturnType<typeof quizSchedule>): boolean {
	if (due <= now.getTime()) return isQuizParked(shape, now, schedule);
	return isQuizWaiting(shape, now, schedule);
}

function dueLabel(due: number, now: number): string {
	const minutes = Math.max(1, Math.round(Math.abs(due - now) / 60_000));
	const span =
		minutes < 60
			? `${minutes} 分钟`
			: minutes < 24 * 60
			? `${Math.round(minutes / 60)} 小时`
			: `${Math.round(minutes / (24 * 60))} 天`;
	return due <= now ? `${span}前到期` : `${span}后`;
}

function clockLabel(due: number): string {
	const d = new Date(due);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class ReminderAgendaModal extends Modal {
	constructor(app: App, private plugin: HistoryLoggingPlugin) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("hl-agenda-modal");
		await this.render();
	}

	private async collect(): Promise<AgendaItem[]> {
		const plugin = this.plugin;
		const now = new Date();
		const schedule = quizSchedule(plugin.settings);
		const [quizzes, progress, entities, events] = await Promise.all([
			plugin.store.readQuizzes(),
			plugin.store.readReciteProgress(),
			plugin.store.readEntities(),
			plugin.store.readEvents(),
		]);
		const items: AgendaItem[] = [];
		for (const quiz of quizzes.values()) {
			if (quiz.status !== "active" || !quiz.nextReview) continue;
			const due = Date.parse(quiz.nextReview);
			if (Number.isNaN(due)) continue;
			if (!inShortPipeline(quiz, now, due, schedule)) continue;
			items.push({
				kind: "quiz",
				id: quiz.id,
				title: quizQuestion(quiz, events.get(quiz.sourceEvId)),
				tag: QUIZ_KIND_LABELS[quiz.kind] ?? "Quiz",
				due,
				ephemeral: false,
			});
		}
		const reciteItem = (
			rec: {
				entity: string;
				from: string;
				to: string;
				nextReview?: string;
			},
			key: string,
			ephemeral: boolean
		): AgendaItem | null => {
			if (!rec.nextReview || rec.from === rec.to) return null;
			const due = Date.parse(rec.nextReview);
			if (Number.isNaN(due)) return null;
			const entity = entities.get(rec.entity);
			const title =
				entity?.labels.find(
					(l) => l.lang === rec.from && l.text.trim()
				)?.text ?? rec.entity;
			return {
				kind: "recite",
				id: key,
				title,
				tag: `${langDisplayName(rec.from)} → ${langDisplayName(
					rec.to
				)}`,
				due,
				ephemeral,
			};
		};
		for (const [key, rec] of progress) {
			if (rec.status !== "active") continue;
			const item = reciteItem(rec, key, false);
			if (!item) continue;
			if (
				!inShortPipeline(toQuizShape(rec), now, item.due, schedule)
			)
				continue;
			items.push(item);
		}
		for (const [key, rec] of plugin.reciteEphemeral) {
			if (progress.has(key)) continue;
			const item = reciteItem(rec, key, true);
			if (item) items.push(item);
		}
		return items;
	}

	private async render(): Promise<void> {
		const host = this.contentEl;
		host.empty();
		host.addClass("hl-agenda");
		const items = await this.collect();
		const now = Date.now();
		const head = host.createDiv({ cls: "hl-agenda-head" });
		const icon = head.createSpan({ cls: "hl-agenda-head-icon" });
		setIcon(icon, "alarm-clock");
		head.createSpan({ cls: "hl-agenda-title", text: "重温清单" });
		head.createSpan({
			cls: "hl-agenda-count",
			text: items.length ? `${items.length} 项` : "",
		});
		if (!items.length) {
			const empty = host.createDiv({ cls: "hl-agenda-empty" });
			const check = empty.createSpan({ cls: "hl-agenda-empty-icon" });
			setIcon(check, "check-circle-2");
			empty.createSpan({ text: "没有等待重温的内容。" });
			return;
		}
		const due = items
			.filter((i) => i.due <= now)
			.sort((a, b) => a.due - b.due);
		const waiting = items
			.filter((i) => i.due > now)
			.sort((a, b) => a.due - b.due);
		if (due.length) this.renderGroup(host, "已到期", due, now, true);
		if (waiting.length)
			this.renderGroup(host, "等待中", waiting, now, false);
	}

	private renderGroup(
		host: HTMLElement,
		label: string,
		items: AgendaItem[],
		now: number,
		overdue: boolean
	): void {
		const section = host.createDiv({ cls: "hl-agenda-section" });
		const heading = section.createDiv({ cls: "hl-agenda-heading" });
		heading.createSpan({
			cls: `hl-agenda-heading-label${overdue ? " is-due" : ""}`,
			text: label,
		});
		heading.createSpan({
			cls: "hl-agenda-heading-count",
			text: String(items.length),
		});
		const list = section.createDiv({ cls: "hl-agenda-list" });
		for (const item of items) {
			const row = list.createDiv({
				cls: `hl-agenda-row${overdue ? " is-due" : ""}`,
			});
			const kind = row.createSpan({ cls: "hl-agenda-kind" });
			setIcon(
				kind,
				item.kind === "quiz" ? "graduation-cap" : "book-a"
			);
			kind.setAttr(
				"aria-label",
				item.kind === "quiz" ? "Quiz" : "词条"
			);
			const body = row.createDiv({ cls: "hl-agenda-body" });
			body.createDiv({ cls: "hl-agenda-item-title", text: item.title });
			const meta = body.createDiv({ cls: "hl-agenda-meta" });
			meta.createSpan({ cls: "hl-agenda-tag", text: item.tag });
			if (item.ephemeral)
				meta.createSpan({
					cls: "hl-agenda-tag is-oneshot",
					text: "一次性",
				});
			const side = row.createDiv({ cls: "hl-agenda-side" });
			side.createSpan({
				cls: `hl-agenda-due${overdue ? " is-due" : ""}`,
				text: dueLabel(item.due, now),
			});
			side.createSpan({
				cls: "hl-agenda-clock",
				text: clockLabel(item.due),
			});
			row.addEventListener("click", () => {
				this.close();
				if (item.kind === "quiz")
					this.plugin.openQuizReminder(item.id);
				else this.plugin.openReciteReminder(item.id);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
