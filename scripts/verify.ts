import { parseYearTag, encodeYearTag, truncateTag } from "../src/year-tag";
import { parseEvMarks, wrapTagAt, unwrapEv } from "../src/parser";
import { generateId, isValidId } from "../src/id";
import { parseEventsFile, serializeEventsFile } from "../src/events-format";
import { parseAbsYear, parseErasFile, eraFor } from "../src/eras";
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

// eras
eq("absyear ad", parseAbsYear("476 AD"), 476);
eq("absyear bare ad", parseAbsYear("710"), 710);
eq("absyear bc", parseAbsYear("509 BC"), -509);
eq("absyear zero rejected", parseAbsYear("0"), null);
const eras = parseErasFile(
	"# eras\n## 共和政ローマ\nrange: 509 BC – 27 BC\n## 奈良時代\nrange: 710 – 794\n"
);
eq("eras parsed", eras.length, 2);
eq("eras sorted earliest first", eras[0].name, "共和政ローマ");
eq("era range keys", [eras[0].startKey, eras[0].endKey], [-509, -27]);
// 500 BC exact -> sortKey -500, inside Republican Rome
eq("eraFor bc point", eraFor(eras, parseYearTag("#bc/05/0/0")!.sortKey)?.name, "共和政ローマ");
// 710 AD -> Nara
eq("eraFor ad point", eraFor(eras, parseYearTag("#ad/07/1/0")!.sortKey)?.name, "奈良時代");
// 600 AD -> no era
eq("eraFor gap", eraFor(eras, parseYearTag("#ad/06/0/0")!.sortKey), null);

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll checks passed.");
