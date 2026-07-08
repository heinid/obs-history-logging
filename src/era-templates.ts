// Bundled era-system templates for one-click import in the manager. These are
// starting points — imported into `eras.md` as plain text, then freely edited.
// Offline only; no network. Dates are conventional round numbers; boundaries
// are debatable and meant to be adjusted by the user.

import { EraSystem, EraBoundary, parseAbsYear } from "./eras";

function sys(name: string, rows: [string, string][]): EraSystem {
	const boundaries: EraBoundary[] = [];
	for (const [yearLabel, eraName] of rows) {
		const startKey = parseAbsYear(yearLabel);
		if (startKey === null) continue;
		boundaries.push({ startKey, yearLabel, name: eraName });
	}
	boundaries.sort((a, b) => a.startKey - b.startKey);
	return { name, boundaries };
}

export const ERA_TEMPLATES: EraSystem[] = [
	sys("日本史", [
		["10000 BC", "縄文時代"],
		["300 BC", "弥生時代"],
		["250", "古墳時代"],
		["538", "飛鳥時代"],
		["710", "奈良時代"],
		["794", "平安時代"],
		["1185", "鎌倉時代"],
		["1336", "室町時代"],
		["1573", "安土桃山時代"],
		["1603", "江戸時代"],
		["1868", "明治"],
		["1912", "大正"],
		["1926", "昭和"],
		["1989", "平成"],
		["2019", "令和"],
	]),
	sys("中国史", [
		["2070 BC", "夏"],
		["1600 BC", "商"],
		["1046 BC", "周"],
		["221 BC", "秦"],
		["206 BC", "漢"],
		["220", "三国"],
		["265", "晋"],
		["420", "南北朝"],
		["581", "隋"],
		["618", "唐"],
		["907", "五代十国"],
		["960", "宋"],
		["1271", "元"],
		["1368", "明"],
		["1644", "清"],
		["1912", "中華民国"],
		["1949", "中華人民共和国"],
	]),
	sys("英国史", [
		["43", "Roman Britain"],
		["410", "Anglo-Saxon"],
		["1066", "Norman"],
		["1154", "Plantagenet"],
		["1485", "Tudor"],
		["1603", "Stuart"],
		["1714", "Georgian"],
		["1837", "Victorian"],
		["1901", "Modern"],
	]),
	sys("ローマ史", [
		["753 BC", "王政ローマ"],
		["509 BC", "共和政ローマ"],
		["27 BC", "ローマ帝国"],
		["285", "分割統治"],
		["476", "西ローマ帝国滅亡後"],
	]),
];
