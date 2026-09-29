/* Tests for the Polls panel's and pop-up's pure rules.
 *
 * Run with `make test-web`.
 *
 * None of these can be produced on demand in a live room: percentages that round to
 * 99, a tie for the lead, a quiz answer marked after a blank option, and — the one
 * that lost launches — an announcement landing while the previous read is still in
 * the air.
 */

import {
  activePoll,
  buildPollInput,
  coalescingReader,
  correctAfterRemove,
  draftFromPoll,
  groupPolls,
  hostPanelView,
  keepDismissals,
  letterFor,
  pollResults,
  sharesOf,
} from "./poll-view.ts";
import type { Poll } from "./api-types.ts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

function poll(over: Partial<Poll>): Poll {
  return {
    id: "p1",
    question: "Which?",
    kind: "poll",
    options: ["A", "B", "C"],
    state: "open",
    createdAt: "2026-09-27T10:00:00Z",
    correctOption: -1,
    votes: [],
    totalVotes: 0,
    myChoice: -1,
    ...over,
  };
}

console.log("sharesOf");
eq(sharesOf([1, 1, 1]), [34, 33, 33], "three thirds add to 100, not 99");
eq(sharesOf([0, 0, 0]), [0, 0, 0], "no votes is all zeros, not NaN");
eq(sharesOf([3, 0]), [100, 0], "a clean sweep");
eq(sharesOf([2, 1, 0]), [67, 33, 0], "an option nobody picked never gets the spare point");
eq(sharesOf([1, 1, 1, 1, 1, 1, 1]).reduce((a, b) => a + b, 0), 100, "sevenths still add to 100");

console.log("\npollResults");
{
  const r = pollResults(poll({ votes: [5, 5, 2], correctOption: 2, myChoice: 1 }));
  eq(r.hasTally, true, "the host's copy has a tally");
  eq(r.total, 12, "total is the sum of the counts");
  eq(r.rows.map((x) => x.leading), [true, true, false], "a tie: both lead");
  eq(r.rows.map((x) => x.correct), [false, false, true], "the correct option is flagged");
  eq(r.rows.map((x) => x.mine), [false, true, false], "your own answer is flagged");
  eq(r.rows.map((x) => x.percent), [42, 42, 16], "percentages add to 100");
}
{
  const r = pollResults(poll({ votes: [] }));
  eq(r.hasTally, false, "the audience's copy has no tally");
  eq(r.rows.every((x) => !x.leading && x.percent === 0), true, "…so nobody leads");
}
eq(
  pollResults(poll({ votes: [0, 0, 0] })).rows.some((x) => x.leading),
  false,
  "no votes yet: nobody leads",
);
eq(pollResults(poll({ votes: [1, 2] })).hasTally, false, "a tally that does not line up is not trusted");

console.log("\ngroupPolls");
{
  const g = groupPolls([
    poll({ id: "d1", state: "draft" }),
    poll({ id: "c-old", state: "closed", closedAt: "2026-09-27T10:05:00Z" }),
    poll({ id: "o", state: "open" }),
    poll({ id: "c-new", state: "closed", closedAt: "2026-09-27T10:30:00Z" }),
    poll({ id: "d2", state: "draft" }),
  ]);
  eq(g.live.map((p) => p.id), ["o"], "the open one is live");
  eq(g.drafts.map((p) => p.id), ["d1", "d2"], "drafts in the order written");
  eq(g.closed.map((p) => p.id), ["c-new", "c-old"], "closed, most recent first");
}

console.log("\nhostPanelView");
eq(hostPanelView(null, null, false), { body: "loading", footer: false }, "loading: no bottom bar to jump away");
eq(hostPanelView(null, "down", false), { body: "failed", footer: false }, "a failed first read: no bar either");
eq(hostPanelView([], null, false), { body: "empty", footer: false }, "empty: its own centered button, no bar");
eq(hostPanelView([], null, true), { body: "empty", footer: false }, "empty while composing: still no bar");
eq(hostPanelView([poll({})], null, false), { body: "list", footer: true }, "a list: the bar");
eq(hostPanelView([poll({})], null, true), { body: "list", footer: false }, "composing hides the bar");
eq(hostPanelView([poll({})], "down", false), { body: "list", footer: true }, "a failed refresh keeps the list");

console.log("\nactivePoll");
eq(activePoll(null), null, "nothing loaded");
eq(activePoll([poll({ state: "closed" })]), null, "closed is history");
eq(activePoll([poll({ myChoice: 0 })]), null, "answered is done");
eq(activePoll([poll({ id: "x" })])?.id, "x", "open and unanswered pops up");

console.log("\nbuildPollInput");
{
  const r = buildPollInput({ question: " Q ", options: ["A", "", "C", "D"], quiz: true, correct: 2 });
  eq(r, { ok: true, input: { question: "Q", kind: "quiz", options: ["A", "C", "D"], correctOption: 1 } },
    "C after a blank is index 1 on the wire, not D");
}
eq(
  buildPollInput({ question: "Q", options: ["A", "B"], quiz: false, correct: 1 }),
  { ok: true, input: { question: "Q", kind: "poll", options: ["A", "B"] } },
  "a poll sends no correct answer",
);
eq(
  buildPollInput({ question: "Q", options: ["A", "B", ""], quiz: true, correct: 2 }).ok,
  false,
  "a quiz whose marked answer is blank cannot be saved",
);
eq(buildPollInput({ question: "", options: ["A", "B"], quiz: false, correct: 0 }).ok, false, "no question");
eq(buildPollInput({ question: "Q", options: ["A", " "], quiz: false, correct: 0 }).ok, false, "one real option");
eq(buildPollInput({ question: "Q", options: ["Yes", "yes "], quiz: false, correct: 0 }).ok, false, "duplicates");
eq(
  buildPollInput({ question: "Q", options: Array.from({ length: 11 }, (_, i) => `o${i}`), quiz: false, correct: 0 }).ok,
  false,
  "more than ten options",
);
eq(buildPollInput({ question: "x".repeat(301), options: ["A", "B"], quiz: false, correct: 0 }).ok, false, "long question");
eq(buildPollInput({ question: "Q", options: ["A", "x".repeat(121)], quiz: false, correct: 0 }).ok, false, "long option");

console.log("\ncorrectAfterRemove");
eq(correctAfterRemove(3, 1), 2, "a row above moves the mark up with its option");
eq(correctAfterRemove(1, 3), 1, "a row below leaves it");
eq(correctAfterRemove(2, 2), 0, "removing the marked row falls back to the first");

console.log("\ndraftFromPoll");
eq(
  draftFromPoll(poll({ kind: "quiz", correctOption: 1, options: ["A", "B"] })),
  { question: "Which?", options: ["A", "B"], quiz: true, correct: 1 },
  "a quiz comes back as a quiz, answer marked",
);

console.log("\nkeepDismissals");
eq([...keepDismissals(new Set(["a", "b"]), "a")], ["a"], "the open poll's dismissal holds");
eq([...keepDismissals(new Set(["a"]), null)], [], "once it closes, the dismissal is dropped");
eq([...keepDismissals(new Set(["a"]), "b")], [], "a different poll is a fresh ask");

console.log("\nletterFor");
eq([0, 1, 9, 10].map(letterFor), ["A", "B", "J", "11"], "letters, then numbers past J");

console.log("\ncoalescingReader");
{
  // One deferred promise per run, released by hand, so the test decides exactly when
  // each read "comes back".
  const releases: Array<() => void> = [];
  let runs = 0;
  const reader = coalescingReader(() => {
    runs++;
    return new Promise<void>((resolve) => releases.push(resolve));
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  reader.request();
  eq(runs, 1, "the first request reads");
  reader.request();
  reader.request();
  reader.request();
  eq(runs, 1, "requests during a read do not start overlapping reads");
  releases[0]();
  await tick();
  eq(runs, 2, "…but exactly one more read runs after it settles (the launch is not lost)");
  releases[1]();
  await tick();
  eq(runs, 2, "and then it stops");
  eq(reader.busy(), false, "idle");
  reader.request();
  eq(runs, 3, "a later request reads straight away");
  releases[2]();
  await tick();
}
{
  let runs = 0;
  let fail = true;
  const reader = coalescingReader(async () => {
    runs++;
    if (fail) {
      fail = false;
      throw new Error("network");
    }
  });
  reader.request();
  reader.request();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  eq(runs, 2, "a failed read still honours the request queued behind it");
  eq(reader.busy(), false, "and a failure does not wedge the reader");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
