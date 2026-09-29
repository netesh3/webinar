/* Engagement: the shared score table, plus the fixture source's paging and the chart maths.
 *
 * Run with `make test-web`. The score cases are the same JSON the Go package reads, so the
 * dashboard and the API are held to one set of numbers. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  asTier,
  bandFor,
  engagementScore,
  scoreComponents,
  sessionWeights,
  tierFor,
  type ScoreInput,
  type SessionTools,
} from "./score.ts";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  filterAndSort,
  nextSort,
  toSearchParams,
  DEFAULT_FILTERS,
  type AttendeeQuery,
} from "./query.ts";
import { fixtureSource } from "./source.ts";
import {
  activityAlpha,
  areaPath,
  cellColor,
  columnLabels,
  linePath,
  linear,
  minuteTicks,
  nearestIndex,
  niceMax,
  NOT_PRESENT,
} from "./viz.ts";

let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

interface ScoreCase {
  name: string;
  session: SessionTools;
  input: ScoreInput;
  score: number;
  tier: string;
}

const table = JSON.parse(
  readFileSync(new URL("../../../api/internal/engagement/testdata/score_cases.json", import.meta.url), "utf8"),
) as { formulaVersion: number; cases: ScoreCase[] };

console.log("\nscore_cases.json");
await test("the table is formula v2", () => assert.equal(table.formulaVersion, 2));
for (const c of table.cases) {
  await test(c.name, () => {
    const score = engagementScore(c.session, c.input);
    assert.equal(score, c.score, "score");
    assert.equal(tierFor(score), c.tier, "tier");
  });
}

console.log("\nscore components");
const ALL: SessionTools = { polls: true, quiz: true, chat: true, qa: true, reactions: true, hands: true };
const NONE: SessionTools = { polls: false, quiz: false, chat: false, qa: false, reactions: false, hands: false };
const zero: ScoreInput = {
  watchSec: 0, sessionSec: 3600, chats: 0, questions: 0, upvotes: 0, pollsPresent: 0,
  pollsAnswered: 0, quizPresent: 0, quizCorrect: 0, reactions: 0, hands: 0,
};

await test("absent for every poll drops polls and quiz from the breakdown", () => {
  const keys = scoreComponents(ALL, zero).map((c) => c.key);
  assert.deepEqual(keys, ["watch", "chat", "qa", "reactions", "hands"]);
});
await test("applied weights always sum to 100 (to display precision)", () => {
  for (const tools of [ALL, NONE, { ...NONE, chat: true }]) {
    const total = scoreComponents(tools, { ...zero, pollsPresent: 1, quizPresent: 1 }).reduce((s, c) => s + c.weight, 0);
    assert.ok(Math.abs(total - 100) < 0.2, `got ${total}`);
  }
});
await test("survey applies only once one was sent", () => {
  assert.ok(!scoreComponents(ALL, zero).some((c) => c.key === "survey"));
  assert.equal(sessionWeights(ALL).find((w) => w.key === "survey")?.weight, 0);
  const sent = { ...ALL, survey: true };
  assert.ok(sessionWeights(sent).find((w) => w.key === "survey")!.weight > 0);
  const part = scoreComponents(sent, { ...zero, surveyClicked: true }).find((c) => c.key === "survey");
  assert.equal(part?.ratio, 0.5);
  assert.equal(part?.detail, "Opened the survey link");
});
await test("session weights zero an unused tool and keep its base", () => {
  const w = sessionWeights({ ...ALL, quiz: false });
  const quiz = w.find((x) => x.key === "quiz");
  assert.equal(quiz?.weight, 0);
  assert.equal(quiz?.baseWeight, 10);
  assert.equal(w.find((x) => x.key === "watch")?.weight, 47.1);
});
await test("points are rounded to 0.1 for display", () => {
  const watch = scoreComponents(ALL, { ...zero, watchSec: 1000 })[0];
  assert.equal(watch.points, Math.round(watch.points * 10) / 10);
});

console.log("\ntiers and bands");
await test("tier thresholds", () => {
  assert.deepEqual([100, 75, 74, 50, 49, 25, 24, 0].map(tierFor), [
    "high", "high", "engaged", "engaged", "passive", "passive", "risk", "risk",
  ]);
});
await test("band thresholds", () => {
  assert.deepEqual([70, 69, 55, 54, 40, 39].map(bandFor), ["excellent", "strong", "strong", "good", "good", "attention"]);
});
await test("unknown tier strings degrade to risk", () => assert.equal(asTier("bogus"), "risk"));

console.log("\nquery + cursor");
await test("cursor round trip and garbage", () => {
  assert.equal(decodeCursor(encodeCursor(150)), 150);
  assert.equal(decodeCursor(undefined), 0);
  assert.equal(decodeCursor("%%%"), 0);
  assert.equal(decodeCursor(btoa("o:-3")), 0);
});
await test("limit clamps to 1..200, default 50", () => {
  assert.deepEqual([undefined, 0, -5, 1, 999, 20.7].map(clampLimit), [50, 50, 1, 1, 200, 20]);
});
await test("search params use the server's names", () => {
  const p = toSearchParams({ sort: "name", dir: "asc", tiers: ["high", "engaged"], q: "  mee ", cursor: "abc", limit: 25 });
  assert.equal(p.toString(), "sort=name&dir=asc&tier=high%2Cengaged&q=mee&cursor=abc&limit=25");
  assert.equal(toSearchParams(DEFAULT_FILTERS).toString(), "sort=score&dir=desc");
});
await test("header clicks: new column starts at its default, same column flips", () => {
  assert.deepEqual(nextSort({ sort: "score", dir: "desc" }, "name"), { sort: "name", dir: "asc" });
  assert.deepEqual(nextSort({ sort: "score", dir: "desc" }, "score"), { sort: "score", dir: "asc" });
  assert.deepEqual(nextSort({ sort: "name", dir: "asc" }, "watch"), { sort: "watch", dir: "desc" });
});

const zeroCounts = {
  chats: 0, questions: 0, upvotes: 0, polls: 0, pollsPresent: 0, quizCorrect: 0,
  quizAnswered: 0, quizPresent: 0, reactions: 0, hands: 0,
};

const src = fixtureSource();
const q = (over: Partial<AttendeeQuery> = {}): AttendeeQuery => ({ ...DEFAULT_FILTERS, ...over });

await test("paging walks every row exactly once", async () => {
  const seen: string[] = [];
  let cursor: string | undefined;
  let total = -1;
  for (let i = 0; i < 20; i++) {
    const page = await src.attendees(q({ cursor, limit: 20 }));
    total = page.total;
    seen.push(...page.rows.map((r) => r.identity));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
});
await test("last page has no nextCursor", async () => {
  const page = await src.attendees(q({ limit: 200 }));
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.rows.length, page.total);
});
await test("score sort is descending with identity tie-break", async () => {
  const { rows } = await src.attendees(q({ limit: 200 }));
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    assert.ok(a.score > b.score || (a.score === b.score && a.identity < b.identity));
  }
});
await test("tier filter and total agree with the summary", async () => {
  const summary = await src.summary();
  const page = await src.attendees(q({ tiers: ["high"], limit: 5 }));
  assert.equal(page.total, summary.tiers.high);
  assert.ok(page.rows.every((r) => r.tier === "high"));
});
await test("search matches name or email, case-insensitive", async () => {
  const { rows } = await src.attendees(q({ limit: 200 }));
  const target = rows[7];
  const byName = await src.attendees(q({ q: target.name.toUpperCase() }));
  assert.ok(byName.rows.some((r) => r.identity === target.identity));
  const byEmail = await src.attendees(q({ q: target.email!.split("@")[0] }));
  assert.ok(byEmail.rows.some((r) => r.identity === target.identity));
  assert.equal((await src.attendees(q({ q: "zzz-nobody" }))).total, 0);
});
await test("name sort ascending", () => {
  const rows = filterAndSort(
    [
      { identity: "b", name: "bea" },
      { identity: "a", name: "Ada" },
    ].map((r) => ({ ...r, score: 0, tier: "risk", watchMin: 0, firstJoinMin: 0, lastLeaveMin: 0, joinTiming: "on_time", visits: 1, counts: zeroCounts, presence: [], intensity: [] })),
    { ...DEFAULT_FILTERS, sort: "name", dir: "asc" },
  );
  assert.deepEqual(rows.map((r) => r.name), ["Ada", "bea"]);
});
await test("summary is internally consistent", async () => {
  const s = await src.summary();
  const tiers = s.tiers.high + s.tiers.engaged + s.tiers.passive + s.tiers.risk;
  assert.equal(tiers, s.kpis.attended);
  assert.equal(s.tiers.noShow, s.kpis.noShows);
  assert.equal(s.activity.chat.length, s.webinar.sessionMin / s.activity.bucketMin);
  assert.equal(s.axis.columns, (await src.attendees(q({ limit: 1 }))).rows[0].presence.length);
  assert.equal(s.retention[0].minute, s.axis.startMin);
});
await test("detail rows match list rows and score from components", async () => {
  const { rows } = await src.attendees(q({ limit: 3 }));
  for (const row of rows) {
    const d = await src.attendee(row.identity);
    assert.deepEqual(d.row, row);
    const pts = d.components.reduce((s, c) => s + c.points, 0);
    assert.ok(Math.abs(pts - row.score) <= 0.6, `${row.identity}: ${pts} vs ${row.score}`);
  }
});
await test("unknown identity rejects; aborted signal rejects", async () => {
  await assert.rejects(src.attendee("att_missing"));
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(src.summary(ctrl.signal));
});

console.log("\nheatmap + charts");
await test("cell colour buckets", () => {
  assert.equal(cellColor(0, 5), NOT_PRESENT);
  assert.equal(cellColor(40, 0), "#e3ecff");
  assert.equal(cellColor(60, 0), "#cddcff");
  assert.equal(cellColor(100, 1), "#94b6ff");
  assert.equal(cellColor(100, 3), "#4f88ff");
  assert.equal(cellColor(100, 4), "#0b47cc");
});
await test("activity alpha is per-row and zero for nothing", () => {
  assert.equal(activityAlpha(0, 5), 0);
  assert.equal(activityAlpha(5, 5), 1);
  assert.equal(activityAlpha(3, 0), 0);
  assert.ok(activityAlpha(1, 10) > 0.15);
});
await test("paths", () => {
  const pts = [{ x: 0, y: 10 }, { x: 5.55, y: 2 }];
  assert.equal(linePath(pts), "M0,10 L5.6,2");
  assert.equal(areaPath(pts, 20), "M0,10 L5.6,2 L5.6,20 L0,20 Z");
  assert.equal(areaPath([], 20), "");
  assert.equal(linear(0, 10, 100, 200)(5), 150);
  assert.equal(linear(3, 3, 0, 10)(3), 0);
});
await test("niceMax and ticks", () => {
  assert.deepEqual([0, 7, 11, 49, 51, 180, 420].map(niceMax), [10, 10, 20, 50, 75, 200, 500]);
  assert.deepEqual(minuteTicks(-10, 60), [0, 15, 30, 45, 60]);
  assert.deepEqual(minuteTicks(-10, 240), [0, 60, 120, 180, 240]);
  assert.equal(nearestIndex([-10, -9, 0, 1], 0.4), 2);
});
await test("heatmap header labels mark the lobby then sparse minutes", () => {
  const labels = columnLabels({ bucketMin: 5, startMin: -10, columns: 14, lobbyColumns: 2 });
  assert.deepEqual(labels, ["Lobby", "", "0m", "", "", "15m", "", "", "30m", "", "", "45m", "", ""]);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
