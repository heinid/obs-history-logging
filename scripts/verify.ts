import {
	parseYearTag,
	encodeYearTag,
	truncateTag,
	describeYear,
	yearTagRegex,
} from "../src/year-tag";
import { parseEvMarks, stripEvMarkers, wrapTagAt, unwrapEv } from "../src/parser";
import { generateId, isValidId } from "../src/id";
import { parseEventsFile, serializeEventsFile } from "../src/events-format";
import {
	parseAbsYear,
	formatAbsYear,
	parseErasFile,
	serializeErasFile,
	eraAt,
} from "../src/eras";
import { tracksIn, trackMatches } from "../src/tracks";
import { parseLayoutsFile, serializeLayoutsFile } from "../src/layouts";
import { EventEntry } from "../src/types";

let failures = 0;
function eq(name: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	if (g !== w) {
		failures++;
		console.error(`FAIL ${name}: got ${g} want ${w}`);
	} else {
		console.log(`ok   ${name}`);
	}
}

// year-tag decode
eq("ad year 710", parseYearTag("#ad/07/1/0"), {
	era: "ad", magnitude: 710, sortKey: 710, precision: "year", span: [710, 710],
});
eq("ad year 794", parseYearTag("#ad/07/9/4")?.magnitude, 794);
eq("ad decade 710s", parseYearTag("#ad/07/1"), {
	era: "ad", magnitude: 710, sortKey: 710, precision: "decade", span: [710, 719],
});
eq("ad century 700s", parseYearTag("#ad/07"), {
	era: "ad", magnitude: 700, sortKey: 700, precision: "century", span: [700, 799],
});
eq("ad year 1185", parseYearTag("#ad/11/8/5")?.magnitude, 1185);
eq("bc year 710", parseYearTag("#bc/07/1/0"), {
	era: "bc", magnitude: 710, sortKey: -710, precision: "year", span: [-710, -710],
});
eq("bc century 700s", parseYearTag("#bc/07"), {
	era: "bc", magnitude: 700, sortKey: -799, precision: "century", span: [-799, -700],
});
eq("bad tag", parseYearTag("#foo/1"), null);

// century labels: 100–199 BC is the 2nd century BC, 1–99 BC the 1st
eq("label ad c8", describeYear(parseYearTag("#ad/07")!), "8th c. AD");
eq("label bc c1", describeYear(parseYearTag("#bc/00")!), "1st c. BC");
eq("label bc c2", describeYear(parseYearTag("#bc/01")!), "2nd c. BC");
eq("label bc c13", describeYear(parseYearTag("#bc/12")!), "13th c. BC");

// bc before ad ordering
const bc = parseYearTag("#bc/07/1/0")!.sortKey;
const ad = parseYearTag("#ad/07/1/0")!.sortKey;
eq("bc sorts before ad", bc < ad, true);

// encode
eq("encode 710", encodeYearTag("ad", 710), "#ad/07/1/0");
eq("encode 794", encodeYearTag("ad", 794), "#ad/07/9/4");
eq("encode 1185", encodeYearTag("ad", 1185), "#ad/11/8/5");
eq("encode 50", encodeYearTag("bc", 50), "#bc/00/5/0");

// truncate
eq("truncate century", truncateTag("#ad/07/1/0", "century"), "#ad/07");
eq("truncate decade", truncateTag("#ad/07/1/0", "decade"), "#ad/07/1");
eq("truncate year", truncateTag("#ad/07/1/0", "year"), "#ad/07/1/0");
eq("truncate century tag stays", truncateTag("#ad/07", "century"), "#ad/07");
eq("truncate too coarse", truncateTag("#ad/07", "decade"), null);

// strict grammar: malformed tags are not year tags at all
eq("reject flat year", parseYearTag("#ad/1912"), null);
eq("reject two-digit decade", parseYearTag("#ad/19/12"), null);
eq("reject one-digit century", parseYearTag("#ad/7"), null);
eq("reject extra segment", parseYearTag("#ad/07/1/0/5"), null);
eq("scan skips flat year", yearTagRegex().test("x #ad/1912 y"), false);
eq("scan skips two-digit decade", yearTagRegex().test("x #ad/19/12 y"), false);
eq("scan accepts exact year", yearTagRegex().test("x #ad/19/1/2 y"), true);

// id
const id = generateId();
eq("id valid", isValidId(id), true);
eq("id reject", isValidId("BAD"), false);

// parser
const doc = "奈良 {ev k7f3a9x1 #ad/07/1/0 } 平安 {ev m2p8q1z5 #ad/07/9/4 }";
const marks = parseEvMarks(doc);
eq("parse 2 marks", marks.length, 2);
eq("mark id", marks[0].id, "k7f3a9x1");
eq("mark tag", marks[0].tag, "#ad/07/1/0");

// wrap
const bare = "abc #ad/07/1/0 def";
const start = bare.indexOf("#");
const end = start + "#ad/07/1/0".length;
eq("wrap", wrapTagAt(bare, start, end, "k7f3a9x1"), "abc {ev k7f3a9x1 #ad/07/1/0 } def");
eq("unwrap", unwrapEv("x {ev k7f3a9x1 #ad/07/1/0 } y", "k7f3a9x1"), "x #ad/07/1/0 y");

// events-format round-trip
const m = new Map<string, EventEntry>();
m.set("k7f3a9x1", {
	id: "k7f3a9x1", tag: "#ad/07/1/0", updated: "2026-07-07",
	summary: "奈良时代定都平城京。\n\n第二段。",
});
const ser = serializeEventsFile(m);
const round = parseEventsFile(ser);
eq("roundtrip tag", round.get("k7f3a9x1")?.tag, "#ad/07/1/0");
eq("roundtrip summary", round.get("k7f3a9x1")?.summary, "奈良时代定都平城京。\n\n第二段。");

// era systems
eq("absyear ad", parseAbsYear("476 AD"), 476);
eq("absyear bare ad", parseAbsYear("710"), 710);
eq("absyear bc", parseAbsYear("509 BC"), -509);
eq("absyear zero rejected", parseAbsYear("0"), null);
eq("formatAbsYear ad", formatAbsYear(710), "710");
eq("formatAbsYear bc", formatAbsYear(-509), "509 BC");

const systems = parseErasFile(
	"# era systems\n## ローマ史\n753 BC 王政ローマ\n509 BC 共和政ローマ\n27 BC ローマ帝国\n476 西ローマ滅亡後\n\n## 日本史\n710 奈良\n794 平安\n"
);
eq("systems parsed", systems.length, 2);
eq("system name", systems[0].name, "ローマ史");
eq("boundaries sorted earliest first", systems[0].boundaries[0].name, "王政ローマ");
eq("boundary keys", systems[0].boundaries.map((b) => b.startKey), [-753, -509, -27, 476]);

// 500 BC -> inside 共和政ローマ (509 BC .. 28 BC)
const rome = systems[0];
eq("eraAt bc point", eraAt(rome, parseYearTag("#bc/05/0/0")!.sortKey)?.name, "共和政ローマ");
eq("eraAt bc range", eraAt(rome, -500)?.range, "509 BC – 28 BC");
// 800 AD -> after last boundary, still in 西ローマ滅亡後 (open-ended)
eq("eraAt open end", eraAt(rome, 800)?.name, "西ローマ滅亡後");
// 900 BC -> before first boundary -> outside coverage
eq("eraAt before first", eraAt(rome, -900), null);
// Japan: 750 AD -> 奈良
eq("eraAt japan", eraAt(systems[1], parseYearTag("#ad/07/5/0")!.sortKey)?.name, "奈良");

// serialize round-trip
const eraRound = parseErasFile(serializeErasFile(systems));
eq("eras roundtrip systems", eraRound.length, 2);
eq("eras roundtrip boundary", eraRound[1].boundaries[1].name, "平安");
eq("eras roundtrip label", eraRound[0].boundaries[1].yearLabel, "509 BC");

// ev markers with bound tracks
const evSrc = "x {ev abcd1234 #ad/04/7/6 #histolog/ローマ史 #histolog/ヨーロッパ史 } y {ev efgh5678 #bc/02/2/1 } z";
const evMarks = parseEvMarks(evSrc);
eq("ev tracks bound", evMarks[0].tracks, ["ローマ史", "ヨーロッパ史"]);
eq("ev tracks none", evMarks[1].tracks, []);
eq(
	"stripEvMarkers keeps tracks",
	stripEvMarkers(evSrc),
	"x #ad/04/7/6 #histolog/ローマ史 #histolog/ヨーロッパ史 y #bc/02/2/1 z"
);
eq(
	"unwrapEv keeps tracks",
	unwrapEv(evSrc, "abcd1234"),
	"x #ad/04/7/6 #histolog/ローマ史 #histolog/ヨーロッパ史 y {ev efgh5678 #bc/02/2/1 } z"
);

// tracks
eq("tracksIn", tracksIn("x #histolog/日本史 y #histolog/中国史 #histolog/日本史"), ["日本史", "中国史"]);
eq("tracksIn none", tracksIn("no tags here #ad/07/1/0"), []);
eq("tracksIn not-midword", tracksIn("foo#histolog/中国史"), []);
const tm = trackMatches("a #histolog/ローマ史 b");
eq("trackMatches index", tm[0].index, "a ".length);
eq("trackMatches name", tm[0].name, "ローマ史");

// layouts round-trip
const layouts = parseLayoutsFile(
	"# layouts\n## 東西対照\n### pane\nfilter: #histolog/日本史\nlens: 日本史\ngroupBy: century\nprofile: 日本史\nsync: true\n### pane\nfilter: #histolog/ローマ史\nlens: ローマ史\ngroupBy: century\nsync: true\n"
);
eq("layouts parsed", layouts.length, 1);
eq("layout panes", layouts[0].panes.length, 2);
eq("layout pane filter", layouts[0].panes[0].filter, "#histolog/日本史");
eq("layout pane no profile", layouts[0].panes[1].profile, "");
const layoutRound = parseLayoutsFile(serializeLayoutsFile(layouts));
eq("layouts roundtrip", layoutRound, layouts);

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll checks passed.");
