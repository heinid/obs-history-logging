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
import {
	parseEntitiesFile,
	serializeEntitiesFile,
	parseDbTypesFile,
	serializeDbTypesFile,
	DEFAULT_DB_TYPES,
	EntityEntry as Ent,
	displayName,
	orderLangs,
	setDisplayLangOrder,
} from "../src/db-format";
import {
	parseDbMarks,
	stripDbMarkers,
	makeDbMarker,
	dbMarkersToHtml,
	aliasAtCursor,
	aliasCandidates,
	queryCandidates,
	triggerQuery,
} from "../src/db-marker";
import {
	wikipediaYearTitle,
	wikipediaYearUrl,
	fillActionUrl,
} from "../src/ev-actions";
import { parseQuizzesFile, serializeQuizzesFile } from "../src/quizzes-format";
import {
	DEFAULT_QUIZ_SCHEDULE,
	QuizEntry,
	isQuizParked,
	isQuizReady,
	isQuizWaiting,
	reviewQuiz,
	reviveQuiz,
} from "../src/quiz";
import {
	maskSourceYear,
	nextReviewLabel,
	quizQuestion,
	rateNotice,
	shortWaitLabel,
} from "../src/quiz-display";
import { makeClozeMarked, mapDbText } from "../src/db-marker";
import { normalizeTag, hasDbTag } from "../src/db-gate";
import { matchesQuery, parseQuery } from "../src/query";
import { scanNoteOccurrences } from "../src/db-occurrences";
import {
	parseReciteDecksFile,
	serializeReciteDecksFile,
	entityMatchesDeck,
	reciteDeckCandidates,
	ReciteDeck,
} from "../src/recite-format";
import { quizDeckStats } from "../src/deck-stats";
import { interject, pruneUpcoming } from "../src/session-queue";
import { maskLabels } from "../src/db-occurrences";
import { parseMapsFile, serializeMapsFile } from "../src/maps-format";
import { imageEmbeds, resizeEmbedIn } from "../src/map-text";

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

// db-gate: tag gate for vault-wide entity features
eq("gate normalize #", normalizeTag("#History"), "history");
eq("gate normalize plain", normalizeTag("  词条 "), "词条");
eq("gate hit frontmatter form", hasDbTag(["history"], ["#history"]), true);
eq("gate hit body form", hasDbTag(["#history"], ["history"]), true);
eq("gate nested tag", hasDbTag(["#history/rome"], ["history"]), true);
eq("gate no cross-nest", hasDbTag(["#historyx"], ["history"]), false);
eq("gate miss", hasDbTag(["#chem"], ["history"]), false);
eq("gate empty enable = off", hasDbTag(["#history"], []), false);
eq("gate blank enable = off", hasDbTag(["#history"], ["", "  "]), false);
eq(
	"gate multiple enable tags",
	hasDbTag(["#词条"], ["history", "词条"]),
	true
);

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
	"# layouts\n## 東西対照\nshow: active-quizzes\n### pane\nfilter: #histolog/日本史\nlens: 日本史\ngroupBy: century\nprofile: 日本史\nsync: true\n### pane\nfilter: #histolog/ローマ史\nlens: ローマ史\ngroupBy: century\nsync: true\n"
);
eq("layouts parsed", layouts.length, 1);
eq("layout show", layouts[0].show, "active-quizzes");
eq("layout panes", layouts[0].panes.length, 2);
eq("layout pane filter", layouts[0].panes[0].filter, "#histolog/日本史");
eq("layout pane no profile", layouts[0].panes[1].profile, "");
const layoutRound = parseLayoutsFile(serializeLayoutsFile(layouts));
eq("layouts roundtrip", layoutRound, layouts);

// quiz data + three-stage memory state
const quiz: QuizEntry = {
	id: "z1y2x3w4",
	sourceEvId: "k7f3a9x1",
	kind: "qa",
	status: "active",
	progress: 0,
	created: "2026-07-10T10:00:00.000Z",
	updated: "2026-07-10T10:00:00.000Z",
	question: "Why did the capital move?",
	answer: "To strengthen central rule.\n\n- point two",
	hint: "Think about administration.",
	attempts: [],
	cycles: [{ startedAt: "2026-07-10T10:00:00.000Z" }],
};
const quizMap = new Map([[quiz.id, quiz]]);
const serializedQuiz = serializeQuizzesFile(quizMap);
const quizRound = parseQuizzesFile(serializedQuiz);
eq("quiz roundtrip", quizRound.get(quiz.id), quiz);
eq(
	"legacy paused quiz migrates to learning",
	parseQuizzesFile(serializedQuiz.replace("status: active", "status: paused")).get(
		quiz.id
	)?.status,
	"active"
);
eq(
	"legacy retired completed quiz migrates to learned",
	parseQuizzesFile(
		serializedQuiz
			.replace("status: active", "status: retired")
			.replace("progress: 0", "progress: 3")
	).get(quiz.id)?.status,
	"mastered"
);
eq(
	"year quiz masks source year",
	quizQuestion(
		{ ...quiz, kind: "year", question: "『種の起源』（1859）" },
		{ id: quiz.sourceEvId, tag: "#ad/18/5/9", summary: "" }
	),
	"『種の起源』（____）"
);
eq(
	"bc year quiz masks source year",
	quizQuestion(
		{ ...quiz, kind: "year", question: "カエサル暗殺（前44）" },
		{ id: quiz.sourceEvId, tag: "#bc/00/4/4", summary: "" }
	),
	"カエサル暗殺（____）"
);
eq(
	"cloze stays blank before reveal",
	quizQuestion({ ...quiz, kind: "cloze", question: "カエサルは____された", answer: "暗殺" }, undefined),
	"カエサルは____された"
);
eq(
	"cloze reveals answer inline",
	quizQuestion(
		{ ...quiz, kind: "cloze", question: "カエサルは____された", answer: "暗殺" },
		undefined,
		true
	),
	"カエサルは==暗殺==された"
);

// cloze over {db} markers: selection ranges are on the folded display text
const clozeSrc = "元寇では{db q3x8k2p1 フビライ}が日本に遠征した";
eq(
	"cloze outside marker keeps it",
	makeClozeMarked(clozeSrc, 12, 14),
	{
		question: "元寇では{db q3x8k2p1 フビライ}が日本に____した",
		answer: "遠征",
	}
);
eq(
	"cloze cutting into marker expands to whole marker",
	makeClozeMarked(clozeSrc, 5, 7),
	{ question: "元寇では____が日本に遠征した", answer: "フビライ" }
);
eq(
	"cloze spanning marker and text",
	makeClozeMarked(clozeSrc, 7, 9),
	{ question: "元寇では____日本に遠征した", answer: "フビライが" }
);
eq(
	"cloze whitespace-only selection unchanged",
	makeClozeMarked("a b", 1, 2),
	{ question: "a b", answer: "" }
);
eq(
	"mapDbText leaves marker framing intact",
	mapDbText("x1467y {db abc 1467}", (c) => c.replace("1467", "____")),
	"x____y {db abc ____}"
);
eq(
	"year mask spares marker ids",
	maskSourceYear("{db a1467b 名誉革命}は1688年", {
		id: "e",
		tag: "#ad/16/8/8",
		summary: "",
	}),
	"{db a1467b 名誉革命}は____年"
);

const t0 = new Date("2026-07-10T10:00:00.000Z");
const afterOne = reviewQuiz(quiz, "remembered", t0, DEFAULT_QUIZ_SCHEDULE);
eq("quiz success advances", afterOne.progress, 1);
eq("quiz first interval is one day", afterOne.nextReview, "2026-07-11T10:00:00.000Z");
eq("quiz cooling not ready", isQuizReady(afterOne, t0), false);
eq("day-scale wait is not the parked state", isQuizWaiting(afterOne, t0), false);
const invalidFuture = {
	...afterOne,
	nextReview: "2099-12-31T23:59:00.000Z",
};
eq("invalid future quiz is ready", isQuizReady(invalidFuture, t0), true);
eq("invalid future label hidden", nextReviewLabel(invalidFuture, t0), "");
const early = reviewQuiz(
	afterOne,
	"remembered",
	new Date("2026-07-10T10:05:00.000Z"),
	DEFAULT_QUIZ_SCHEDULE
);
eq("early success does not advance", early.progress, 1);
eq("early success keeps due time", early.nextReview, afterOne.nextReview);
eq("early attempt marked", early.attempts[1].early, true);
const forgot = reviewQuiz(
	afterOne,
	"forgot",
	new Date("2026-07-10T10:05:00.000Z"),
	DEFAULT_QUIZ_SCHEDULE
);
eq("early forgot regresses", forgot.progress, 0);
eq("forgot retry interval", forgot.nextReview, "2026-07-10T10:15:00.000Z");
eq(
	"forgot card is parked as waiting",
	isQuizWaiting(forgot, new Date("2026-07-10T10:05:00.000Z")),
	true
);
eq(
	"forgot card ready after wait",
	isQuizReady(forgot, new Date("2026-07-10T10:15:00.000Z")),
	true
);
const afterTwo = reviewQuiz(
	afterOne,
	"remembered",
	new Date("2026-07-11T10:00:00.000Z"),
	DEFAULT_QUIZ_SCHEDULE
);
eq("quiz second interval is three days", afterTwo.nextReview, "2026-07-14T10:00:00.000Z");
const mastered = reviewQuiz(
	afterTwo,
	"remembered",
	new Date("2026-07-14T10:00:00.000Z"),
	DEFAULT_QUIZ_SCHEDULE
);
eq("quiz third success masters", mastered.status, "mastered");
eq("quiz mastery records cycle", mastered.cycles[0].completedAt, "2026-07-14T10:00:00.000Z");

// optional first-learn recheck
const recheckSchedule = { ...DEFAULT_QUIZ_SCHEDULE, remindRecheck: true };
const recheckPending = reviewQuiz(quiz, "remembered", t0, recheckSchedule);
eq("recheck defers first step", recheckPending.progress, 0);
eq("recheck flag set", recheckPending.pendingRecheck, true);
eq("recheck due in ten minutes", recheckPending.nextReview, "2026-07-10T10:10:00.000Z");
eq(
	"recheck card is parked as waiting",
	isQuizWaiting(recheckPending, t0, recheckSchedule),
	true
);
const recheckPassed = reviewQuiz(
	recheckPending,
	"remembered",
	new Date("2026-07-10T10:10:00.000Z"),
	recheckSchedule
);
eq("passed recheck completes step 1", recheckPassed.progress, 1);
eq("passed recheck clears flag", recheckPassed.pendingRecheck, false);
eq("passed recheck schedules next day", recheckPassed.nextReview, "2026-07-11T10:10:00.000Z");
const recheckFailed = reviewQuiz(
	recheckPending,
	"forgot",
	new Date("2026-07-10T10:10:00.000Z"),
	recheckSchedule
);
eq("failed recheck keeps progress at 0", recheckFailed.progress, 0);
eq("failed recheck retries in ten minutes", recheckFailed.nextReview, "2026-07-10T10:20:00.000Z");

// parked quizzes (current short retry/recheck cycle) get their own timeline
// card, through the wait and for parkMinutes past the due time; older
// forgot attempts never park
eq("fresh quiz not parked", isQuizParked(quiz, t0), false);
eq("remembered quiz not parked", isQuizParked(afterOne, t0), false);
eq(
	"recheck-pending parked",
	isQuizParked(recheckPending, t0, recheckSchedule),
	true
);
eq("forgot parked while waiting", isQuizParked(forgot, t0), true);
eq(
	"forgot parked shortly after due",
	isQuizParked(forgot, new Date("2026-07-10T12:00:00.000Z")),
	true
);
eq(
	"stale forgot unparked past park window",
	isQuizParked(forgot, new Date("2026-07-12T10:15:00.000Z")),
	false
);
eq(
	"park window is configurable",
	isQuizParked(
		forgot,
		new Date("2026-07-10T11:30:00.000Z"),
		{ ...DEFAULT_QUIZ_SCHEDULE, parkMinutes: 60 }
	),
	false
);
eq(
	"failed recheck parked",
	isQuizParked(recheckFailed, t0, recheckSchedule),
	true
);
eq(
	"passed recheck unparked",
	isQuizParked(recheckPassed, t0, recheckSchedule),
	false
);
eq("mastered not parked", isQuizParked(mastered, t0), false);

// short-wait countdown + rating feedback copy
eq(
	"recheck wait label",
	shortWaitLabel(recheckPending, t0, recheckSchedule),
	"⏰ 重温确认 · 10 分钟后可练"
);
eq(
	"retry wait label",
	shortWaitLabel(forgot, new Date("2026-07-10T10:05:00.000Z")),
	"⏰ 重试 · 10 分钟后可练"
);
eq(
	"wait label empty when ready",
	shortWaitLabel(recheckPending, new Date("2026-07-10T10:10:00.000Z"), recheckSchedule),
	""
);
eq(
	"recheck rate notice",
	rateNotice(recheckPending, 3, recheckSchedule),
	"✓ 已记住 · ⏰ 10 分钟后重温确认，通过才算完成这一步"
);
eq("progress rate notice", rateNotice(afterOne, 3), "掌握进度：1/3");
eq("mastered rate notice", rateNotice(mastered, 3), "这个 Quiz 已学过。");
const revived = reviveQuiz(mastered, new Date("2026-08-01T00:00:00.000Z"));
eq("quiz revive resets progress", revived.progress, 0);
eq("quiz revive adds cycle", revived.cycles.length, 2);

// entity db: entities.md round-trip
const ents = new Map<string, Ent>();
ents.set("q3x8k2p1", {
	id: "q3x8k2p1",
	type: "polity",
	labels: [
		{ lang: "zh", text: "希腊" },
		{ lang: "en", text: "Greece" },
		{ lang: "ja", text: "ギリシャ" },
	],
	readings: [{ lang: "ja", text: "girisha" }],
	audios: [{ lang: "ja", link: "[[greece.mp3]]" }],
	tags: ["欧洲史", "政权"],
	updated: "2026-07-09",
	body: "自由正文。\n\n第二段。",
});
const entSer = serializeEntitiesFile(ents);
const entRound = parseEntitiesFile(entSer);
eq("entity roundtrip type", entRound.get("q3x8k2p1")?.type, "polity");
eq("entity roundtrip labels", entRound.get("q3x8k2p1")?.labels, ents.get("q3x8k2p1")!.labels);
eq("entity roundtrip readings", entRound.get("q3x8k2p1")?.readings, ents.get("q3x8k2p1")!.readings);
eq("entity roundtrip audios", entRound.get("q3x8k2p1")?.audios, ents.get("q3x8k2p1")!.audios);
eq("entity roundtrip tags", entRound.get("q3x8k2p1")?.tags, ["欧洲史", "政权"]);
eq("entity roundtrip body", entRound.get("q3x8k2p1")?.body, "自由正文。\n\n第二段。");

// db-types round-trip + defaults
eq("db types roundtrip", parseDbTypesFile(serializeDbTypesFile(DEFAULT_DB_TYPES)), DEFAULT_DB_TYPES);
eq("db types skip malformed", parseDbTypesFile("- person | notacolor\n- place | #4faa5e\n"), [
	{ name: "place", color: "#4faa5e" },
]);

// {db …} markers
const dbDoc = "元寇 — {db q3x8k2p1 ギリシャ}遠征と{db a1b2c3d4 フビライ}。";
const dbMarks = parseDbMarks(dbDoc);
eq("db marks parsed", dbMarks.length, 2);
eq("db mark id", dbMarks[0].id, "q3x8k2p1");
eq("db mark text", dbMarks[0].text, "ギリシャ");
eq("db strip", stripDbMarkers(dbDoc), "元寇 — ギリシャ遠征とフビライ。");
eq("db make", makeDbMarker("q3x8k2p1", "希腊"), "{db q3x8k2p1 希腊}");
eq(
	"db to html",
	dbMarkersToHtml("{db q3x8k2p1 希腊}", () => "#4faa5e"),
	'<span class="hl-db-ref" data-db-id="q3x8k2p1" style="text-decoration-color: #4faa5e">希腊</span>'
);
eq("db html unknown id folds to text", dbMarkersToHtml("{db q3x8k2p1 <b>}", () => null), "&lt;b&gt;");

// recognition: longest match, word boundaries, no firing inside markers
const dict = [
	{ ...ents.get("q3x8k2p1")!, labels: [{ lang: "zh", text: "希腊" }] },
	{
		id: "a1b2c3d4", type: "person",
		labels: [{ lang: "en", text: "Alexander" }, { lang: "en", text: "Alexander the Great" }],
		readings: [], audios: [], tags: [], body: "",
	},
];
eq("alias hit", aliasAtCursor("公元前古希腊", dict)?.alias, "希腊");
eq("alias longest wins", aliasAtCursor("x Alexander the Great", dict)?.alias, "Alexander the Great");
eq("alias word boundary", aliasAtCursor("xAlexander", dict), null);
eq("alias none", aliasAtCursor("罗马", dict), null);
eq("alias not inside marker", aliasAtCursor("{db q3x8k2p1 希腊", dict), null);

// multi-candidate completion (dropdown): prefix matches, ranking, boundaries
eq("cand exact", aliasCandidates("公元前古希腊", dict)[0]?.alias, "希腊");
eq("cand exact flag", aliasCandidates("公元前古希腊", dict)[0]?.exact, true);
eq("cand prefix", aliasCandidates("古希", dict)[0]?.matched, "希");
eq("cand prefix alias", aliasCandidates("古希", dict)[0]?.alias, "希腊");
const alexCands = aliasCandidates("about Alexander", dict);
eq("cand one per entity", alexCands.length, 1);
eq("cand exact before prefix", alexCands[0].exact, true);
eq("cand latin single char skipped", aliasCandidates("x A", dict), []);
eq("cand word boundary", aliasCandidates("xAlexander", dict), []);
eq("cand not inside marker", aliasCandidates("{db q3x8k2p1 希腊", dict), []);
eq("cand none", aliasCandidates("罗马", dict), []);

// surname completion: last token of a spaced name as its own alias
eq("surname hit", aliasCandidates("x Caes", [
	{
		id: "b2c3d4e5", type: "person",
		labels: [{ lang: "en", text: "Gaius Julius Caesar" }],
		readings: [], audios: [], tags: [], body: "",
	},
], 8, false, true)[0]?.alias, "Caesar");
eq("surname off by default", aliasCandidates("x Caes", [
	{
		id: "b2c3d4e5", type: "person",
		labels: [{ lang: "en", text: "Gaius Julius Caesar" }],
		readings: [], audios: [], tags: [], body: "",
	},
]), []);
eq("surname full name still wins", aliasCandidates("Gaius Julius Caesar", [
	{
		id: "b2c3d4e5", type: "person",
		labels: [{ lang: "en", text: "Gaius Julius Caesar" }],
		readings: [], audios: [], tags: [], body: "",
	},
], 8, false, true)[0]?.alias, "Gaius Julius Caesar");

// explicit `//` completion: trigger detection + loose matching
eq("trig none", triggerQuery("just text"), null);
eq("trig single slash", triggerQuery("a/b"), null);
eq("trig hit", triggerQuery("xx//Caes"), { query: "Caes", start: 2 });
eq("trig fullwidth", triggerQuery("／／太"), { query: "太", start: 0 });
eq("trig mixed", triggerQuery("/／Ju"), { query: "Ju", start: 0 });
eq("trig newline breaks", triggerQuery("//a\nb"), null);
eq("trig not inside marker", triggerQuery("{db q3x8k2p1 //希"), null);
eq("query mid-name token", queryCandidates("the", dict)[0]?.alias, "Alexander the Great");
eq("query substring", queryCandidates("lexand", dict)[0]?.alias, "Alexander");
eq("query start beats substring", queryCandidates("alex", dict)[0]?.alias, "Alexander");
eq("query cjk", queryCandidates("希", dict)[0]?.alias, "希腊");
eq("query none", queryCandidates("罗马", dict), []);
eq("query empty", queryCandidates("  ", dict), []);

// preferred display-language order: display names, lang sorting and
// completion tie-breaks all follow it
const multiLang: Ent = {
	id: "c3d4e5f6", type: "event",
	labels: [
		{ lang: "ja", text: "明治維新" },
		{ lang: "zh", text: "明治维新" },
		{ lang: "en", text: "Meiji Restoration" },
	],
	readings: [], audios: [], tags: [], body: "",
};
eq("display default first label", displayName(multiLang), "明治維新");
setDisplayLangOrder(["zh", "ja", "en"]);
eq("display preferred lang", displayName(multiLang), "明治维新");
eq("display missing lang falls back", displayName({
	...multiLang,
	labels: [{ lang: "ja", text: "元寇" }],
}), "元寇");
eq("order langs", orderLangs(["en", "ja", "fr", "zh"]), ["zh", "ja", "en", "fr"]);
// Both spellings share the 明治 prefix; the zh alias must win the tie.
eq("cand lang tie-break", aliasCandidates("明治", [multiLang])[0]?.alias, "明治维新");
eq("query lang tie-break", queryCandidates("明治", [multiLang])[0]?.alias, "明治维新");
setDisplayLangOrder(["ja", "zh", "en"]);
eq("cand lang tie-break ja", aliasCandidates("明治", [multiLang])[0]?.alias, "明治維新");
setDisplayLangOrder([]);
eq("display order reset", displayName(multiLang), "明治維新");

// query language: file:#tag / path: terms combine with text terms via
// the existing AND / OR / NOT rules
const qctx = {
	fileTags: ["#history/japan", "#精读"],
	filePath: "词条测试/元寇笔记.md",
};
eq("q text still matches", matchesQuery("元寇 襲来", parseQuery("元寇"), qctx), true);
eq("q file tag hit", matchesQuery("", parseQuery("file:#history"), qctx), true);
eq("q file tag nested", matchesQuery("", parseQuery("file:#history/japan"), qctx), true);
eq("q file tag no hash", matchesQuery("", parseQuery("file:history"), qctx), true);
eq("q file tag miss", matchesQuery("", parseQuery("file:#chem"), qctx), false);
eq("q file tag no ctx", matchesQuery("", parseQuery("file:#history")), false);
eq("q file AND text", matchesQuery("蒙古", parseQuery("file:#history 蒙古"), qctx), true);
eq("q file AND text miss", matchesQuery("罗马", parseQuery("file:#history 蒙古"), qctx), false);
eq("q file OR", matchesQuery("", parseQuery("file:#chem OR file:#精读"), qctx), true);
eq("q file NOT", matchesQuery("", parseQuery("-file:#draft"), qctx), true);
eq("q file NOT hit", matchesQuery("", parseQuery("-file:#history"), qctx), false);
eq("q path hit", matchesQuery("", parseQuery("path:词条测试/"), qctx), true);
eq("q path miss", matchesQuery("", parseQuery("path:_chronology/"), qctx), false);
eq("q path case", matchesQuery("", parseQuery("path:元寇笔记.MD"), qctx), true);
eq(
	"q mixed groups",
	matchesQuery("元寇", parseQuery("file:#chem 元寇 OR file:#history/japan -罗马"), qctx),
	true
);

// note occurrences: {db id} hits, fn-wrap detection, [fnid.date] lookup
const occNote = [
	"press conference in ~={green|fn:3t6m}{db 1tn835zw Ankara}=~ today {;; 3t6m #积累 }",
	"later they returned to {db 1tn835zw Ankara} for the summit",
	"a different city {db zz11zz11 Rome} here",
	"`{db 1tn835zw Ankara}` in code is still counted at text level",
	"",
	"<!-- annotations -->",
	"[3t6m.date]: 2026-07-15T00:40:48.723Z",
].join("\n");
const occ = scanNoteOccurrences(occNote, "1tn835zw");
eq("occ count", occ.occurrences.length, 3);
eq("occ first has fn", occ.occurrences[0]?.fnId, "3t6m");
eq("occ second no fn", occ.occurrences[1]?.fnId, undefined);
eq("occ first annotated", occ.firstAnnotated, "2026-07-15T00:40:48.723Z");
eq(
	"occ snippet cleaned",
	occ.occurrences[0]?.snippet,
	"press conference in Ankara today"
);
eq(
	"occ jump slice",
	occNote.slice(
		occ.occurrences[1].offset,
		occ.occurrences[1].offset + occ.occurrences[1].length
	),
	"{db 1tn835zw Ankara}"
);
eq("occ other id", scanNoteOccurrences(occNote, "zz11zz11").occurrences.length, 1);
eq("occ no date", scanNoteOccurrences(occNote, "zz11zz11").firstAnnotated, undefined);
eq("occ absent id", scanNoteOccurrences(occNote, "aaaa1111").occurrences, []);
const occNoMeta = scanNoteOccurrences(
	"x ~={red|fn:gbp6}{db 1tn835zw 安卡拉}=~ y",
	"1tn835zw"
);
eq("occ wrap without date", occNoMeta.occurrences[0]?.fnId, "gbp6");
eq("occ wrap without date time", occNoMeta.firstAnnotated, undefined);
const occEarliest = scanNoteOccurrences(
	[
		"~={green|fn:aaaa}{db 1tn835zw A}=~",
		"~={green|fn:bbbb}{db 1tn835zw B}=~",
		"[aaaa.date]: 2026-07-15T10:00:00.000Z",
		"[bbbb.date]: 2026-07-14T10:00:00.000Z",
	].join("\n"),
	"1tn835zw"
);
eq("occ earliest date wins", occEarliest.firstAnnotated, "2026-07-14T10:00:00.000Z");

// ⌛ menu: wikipedia year pages + action URL templates
const y1274 = parseYearTag("#ad/12/7/4")!;
const yBc44 = parseYearTag("#bc/00/4/4")!;
eq("wiki ja ad", wikipediaYearTitle("ja", y1274), "1274年");
eq("wiki ja bc", wikipediaYearTitle("ja", yBc44), "紀元前44年");
eq("wiki zh bc", wikipediaYearTitle("zh", yBc44), "前44年");
eq("wiki en ad", wikipediaYearTitle("en", y1274), "1274");
eq("wiki en bc", wikipediaYearTitle("en", yBc44), "44 BC");
eq(
	"wiki url ja",
	wikipediaYearUrl("ja", y1274),
	"https://ja.wikipedia.org/wiki/" + encodeURIComponent("1274年")
);
eq(
	"action url fill",
	fillActionUrl("https://x.test/?y={year}&t={tag}&k={track}", yBc44, "#bc/00/4/4", "ローマ史"),
	"https://x.test/?y=-44&t=%23bc%2F00%2F4%2F4&k=" + encodeURIComponent("ローマ史")
);

// recite decks: parse / serialize round-trip
{
	const src = [
		"# History Logging — recitation decks",
		"",
		"## 日本史 · 中→日",
		"from: zh",
		"to: ja, en",
		"tags: 日本史",
		"types: person, polity",
		"",
	].join("\n");
	const decks = parseReciteDecksFile(src);
	eq("recite parse count", decks.length, 1);
	eq("recite parse from", decks[0].from, "zh");
	eq("recite parse to", decks[0].to, ["ja", "en"]);
	eq("recite parse tags", decks[0].tags, ["日本史"]);
	eq("recite parse types", decks[0].types, ["person", "polity"]);
	eq(
		"recite round-trip",
		parseReciteDecksFile(serializeReciteDecksFile(decks)),
		decks
	);
}

// recite deck candidate selection
{
	const mk = (
		id: string,
		type: string,
		labels: [string, string][],
		tags: string[]
	): Ent => ({
		id,
		type,
		labels: labels.map(([lang, text]) => ({ lang, text })),
		readings: [],
		audios: [],
		tags,
		body: "",
	});
	const deck: ReciteDeck = {
		name: "d",
		from: "zh",
		to: ["ja", "en"],
		tags: ["日本史"],
		types: [],
	};
	const withBoth = mk(
		"a",
		"person",
		[
			["zh", "北条时宗"],
			["ja", "北条時宗"],
		],
		["日本史"]
	);
	const noTarget = mk("b", "person", [["zh", "只有中文"]], ["日本史"]);
	const noSource = mk("c", "person", [["ja", "日本語のみ"]], ["日本史"]);
	const wrongTag = mk(
		"d",
		"person",
		[
			["zh", "中国史"],
			["en", "China"],
		],
		["中国史"]
	);
	const nestedTag = mk(
		"e",
		"person",
		[
			["zh", "嵌套"],
			["en", "Nested"],
		],
		["日本史/镰仓"]
	);
	eq("deck match both langs", entityMatchesDeck(withBoth, deck), true);
	eq("deck reject no target", entityMatchesDeck(noTarget, deck), false);
	eq("deck reject no source", entityMatchesDeck(noSource, deck), false);
	eq("deck reject wrong tag", entityMatchesDeck(wrongTag, deck), false);
	eq("deck nested tag hit", entityMatchesDeck(nestedTag, deck), true);
	eq(
		"deck candidates",
		reciteDeckCandidates(
			[withBoth, noTarget, noSource, wrongTag, nestedTag],
			deck
		).map((e) => e.id),
		["a", "e"]
	);
	// type scope
	const typed: ReciteDeck = { ...deck, tags: [], types: ["polity"] };
	eq("deck type reject", entityMatchesDeck(withBoth, typed), false);
	eq(
		"deck type accept",
		entityMatchesDeck({ ...withBoth, type: "polity" }, typed),
		true
	);
}

// quiz deck stats aggregation
{
	const q = (
		id: string,
		status: "active" | "mastered",
		nextReview: string | undefined,
		attempts: { at: string; result: QuizResult }[]
	): QuizEntry => ({
		id,
		sourceEvId: "ev",
		kind: "qa",
		status,
		progress: 0,
		nextReview,
		created: "2026-01-01",
		updated: "2026-01-01",
		question: "",
		answer: "",
		hint: "",
		attempts: attempts.map((a) => ({
			at: a.at,
			result: a.result,
			early: false,
			progressBefore: 0,
			progressAfter: 0,
		})),
		cycles: [],
	});
	const now = new Date("2026-07-15T12:00:00Z");
	const stats = quizDeckStats(
		[
			q("1", "active", undefined, [
				{ at: "2026-07-14T09:00:00Z", result: "remembered" },
			]),
			q("2", "active", "2026-07-15T12:05:00Z", [
				{ at: "2026-07-14T10:00:00Z", result: "forgot" },
			]),
			q("3", "mastered", undefined, [
				{ at: "2026-07-13T10:00:00Z", result: "remembered" },
			]),
		],
		now,
		DEFAULT_QUIZ_SCHEDULE
	);
	eq("deck stats active", stats.active, 2);
	eq("deck stats mastered", stats.mastered, 1);
	eq("deck stats due (no nextReview ready)", stats.due, 1);
	eq("deck stats last day", stats.lastReviewedAt, "2026-07-14T10:00:00Z");
	eq("deck stats last remembered", stats.lastResults.remembered, 1);
	eq("deck stats last forgot", stats.lastResults.forgot, 1);
}

// session queue interjection
{
	const base = { ids: ["a", "b", "c", "d"], index: 1 };
	eq(
		"interject after current, earliest due first",
		interject(base, [
			{ id: "y", due: "2026-01-01T10:05:00Z" },
			{ id: "x", due: "2026-01-01T10:01:00Z" },
		]).ids,
		["a", "b", "x", "y", "c", "d"]
	);
	eq(
		"interject moves an upcoming duplicate forward",
		interject(base, [{ id: "d", due: "2026-01-01T10:00:00Z" }]).ids,
		["a", "b", "d", "c"]
	);
	eq(
		"interject re-adds an already-answered card (retry loop)",
		interject(base, [{ id: "a", due: "2026-01-01T10:00:00Z" }]).ids,
		["a", "b", "a", "c", "d"]
	);
	eq(
		"interject leaves the current card alone",
		interject(base, [{ id: "b", due: "2026-01-01T10:00:00Z" }]).ids,
		["a", "b", "c", "d"]
	);
	eq(
		"prune keeps head, filters upcoming",
		pruneUpcoming(base, (id) => id !== "c").ids,
		["a", "b", "d"]
	);
}

// context hint masking
{
	eq(
		"mask all spellings, longest first",
		maskLabels("Caesar crossed the Rubicon; caesar again", [
			"Caesar",
			"Gaius Julius Caesar",
		]),
		"____ crossed the Rubicon; ____ again"
	);
	eq(
		"mask collapses adjacent blanks",
		maskLabels("ローマ 罗马 Rome", ["ローマ", "罗马", "Rome"]),
		"____ "
	);
	eq(
		"mask escapes regex metacharacters",
		maskLabels("c++ is here", ["c++"]),
		"____ is here"
	);
}

// maps.md round trip
{
	const src = [
		"# History Logging — maps",
		"",
		"## m1a2b3c4",
		"title: 伯罗奔尼撒战争形势图",
		"image: maps/pelo.png",
		"range: #bc/04/3/1",
		"events: k7f3a9x1, p2d8c4n5",
		"entities: a1b2c3d4",
		"updated: 2026-07-17",
		"",
		"自由注记",
		"",
	].join("\n");
	const maps = parseMapsFile(src);
	const m = maps.get("m1a2b3c4");
	eq("maps parse title", m?.title, "伯罗奔尼撒战争形势图");
	eq("maps parse image", m?.image, "maps/pelo.png");
	eq("maps parse events", m?.events.join(","), "k7f3a9x1,p2d8c4n5");
	eq("maps parse body", m?.body, "自由注记");
	eq("maps round trip", serializeMapsFile(parseMapsFile(serializeMapsFile(maps))), serializeMapsFile(maps));
}

// image embeds + resize suffix rewrite
{
	eq(
		"image embeds found",
		imageEmbeds("text ![[a.png]] mid ![[b.jpg|300]] ![[note.md]]").join(","),
		"a.png,b.jpg"
	);
	eq(
		"resize adds width suffix",
		resizeEmbedIn("x ![[a.png]] y", "a.png", 320)?.text,
		"x ![[a.png|320]] y"
	);
	eq(
		"resize replaces width suffix",
		resizeEmbedIn("x ![[a.png|100]] y", "a.png", 240)?.text,
		"x ![[a.png|240]] y"
	);
	eq(
		"resize picks nearest occurrence",
		resizeEmbedIn("![[a.png]] pad ![[a.png]]", "a.png", 200, 20)?.text,
		"![[a.png]] pad ![[a.png|200]]"
	);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll checks passed.");
