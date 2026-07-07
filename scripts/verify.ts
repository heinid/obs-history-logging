import { parseYearTag, encodeYearTag, truncateTag } from "../src/year-tag";
import { parseEvMarks, wrapTagAt, unwrapEv } from "../src/parser";
import { generateId, isValidId } from "../src/id";
import { parseEventsFile, serializeEventsFile } from "../src/events-format";
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
	id: "k7f3a9x1", tag: "#ad/07/1/0", source: "[[Note]]", updated: "2026-07-07",
	summary: "奈良时代定都平城京。\n\n第二段。",
});
const ser = serializeEventsFile(m);
const round = parseEventsFile(ser);
eq("roundtrip tag", round.get("k7f3a9x1")?.tag, "#ad/07/1/0");
eq("roundtrip source", round.get("k7f3a9x1")?.source, "[[Note]]");
eq("roundtrip summary", round.get("k7f3a9x1")?.summary, "奈良时代定都平城京。\n\n第二段。");

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll checks passed.");
