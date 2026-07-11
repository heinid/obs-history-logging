// Saved multi-pane layouts, persisted in `_chronology/layouts.md`. A layout
// is a snapshot of every open timeline pane's state (filter + lens + grouping
// + loaded view), so a whole parallel-comparison desk can be
// reopened in one step. Format:
//
//   ## 東西対照
//   ### pane
//   filter: #histolog/日本史
//   lens: 日本史
//   groupBy: century
//   profile: 日本史
//   ### pane
//   ...

export interface LayoutPane {
	filter: string;
	lens: string;
	groupBy: string;
	profile: string;
}

export type TimelineShow =
	| "events"
	| "active-quizzes"
	| "mastered-quizzes"
	| "all-quizzes";

export interface TimelineLayout {
	name: string;
	show: TimelineShow;
	panes: LayoutPane[];
}

export const LAYOUTS_HEADER = "# History Logging — layouts";

const DEFAULT_PANE: LayoutPane = {
	filter: "",
	lens: "",
	groupBy: "century",
	profile: "",
};

export function parseLayoutsFile(content: string): TimelineLayout[] {
	const normalised = content.replace(/\r\n/g, "\n");
	const re = /^##\s+(.+?)\s*$/gm;
	const heads: { name: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null) {
		heads.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
	}
	const layouts: TimelineLayout[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const body = normalised.slice(h.bodyStart, end);
		const panes: LayoutPane[] = [];
		let show: TimelineShow = "events";
		let pane: LayoutPane | null = null;
		for (const raw of body.split("\n")) {
			const line = raw.trim();
			if (/^###\s+pane\s*$/i.test(line)) {
				pane = { ...DEFAULT_PANE };
				panes.push(pane);
				continue;
			}
			const kv = /^(\w+):\s*(.*)$/.exec(line);
			if (!kv) continue;
			const [, key, value] = kv;
			if (!pane && key === "show" && isTimelineShow(value.trim())) {
				show = value.trim() as TimelineShow;
				continue;
			}
			if (!pane) continue;
			if (key === "filter") pane.filter = value.trim();
			else if (key === "lens") pane.lens = value.trim();
			else if (key === "groupBy") pane.groupBy = value.trim();
			else if (key === "profile") pane.profile = value.trim();
			// Unknown keys (e.g. the retired `sync`) are ignored.
		}
		if (panes.length) layouts.push({ name: h.name, show, panes });
	}
	return layouts;
}

export function serializeLayoutsFile(layouts: TimelineLayout[]): string {
	const parts: string[] = [LAYOUTS_HEADER, ""];
	for (const l of layouts) {
		parts.push(`## ${l.name}`);
		if (l.show !== "events") parts.push(`show: ${l.show}`);
		for (const p of l.panes) {
			parts.push("### pane");
			if (p.filter) parts.push(`filter: ${p.filter}`);
			if (p.lens) parts.push(`lens: ${p.lens}`);
			parts.push(`groupBy: ${p.groupBy}`);
			if (p.profile) parts.push(`profile: ${p.profile}`);
		}
		parts.push("");
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}

export function isTimelineShow(value: string): value is TimelineShow {
	return (
		value === "events" ||
		value === "active-quizzes" ||
		value === "mastered-quizzes" ||
		value === "all-quizzes"
	);
}
