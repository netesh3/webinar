/* The create-webinar form's two steps: old `?step=` links, Next and Back, and what step 1
 * holds Next and Schedule for.
 *
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import {
  issuesFor,
  legacyAnchor,
  nextStep,
  prevStep,
  scheduleIssues,
  stepFrom,
  STEPS,
  type IssueInput,
} from "./schedule-wizard.ts";

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n    ${(e as Error).message}`);
  }
}

const NOW = Date.parse("2026-09-28T18:00:00Z");
const ok: IssueInput = {
  topic: "Q4 roadmap",
  startsAt: new Date(NOW + 3_600_000),
  editing: false,
  now: NOW,
  questionProblem: null,
  watchUrl: "",
  multistream: false,
  surveyProblem: null,
};
const ids = (i: IssueInput) => scheduleIssues(i).map((x) => x.id);

console.log("steps");
test("exactly two, in order", () => {
  assert.deepEqual(STEPS.map((s) => s.title), ["The webinar", "Messages & follow-ups"]);
});
test("old links still open the right step", () => {
  assert.equal(stepFrom(null), "webinar");
  for (const v of ["webinar", "details", "survey", "review", "schedule"]) {
    assert.equal(stepFrom(v), "webinar", v);
  }
  for (const v of ["messages", "followups", "follow-ups"]) {
    assert.equal(stepFrom(v), "messages", v);
  }
  assert.equal(stepFrom("nonsense"), "webinar");
  assert.equal(stepFrom("__proto__"), "webinar");
  assert.equal(stepFrom("toString"), "webinar");
  assert.equal(legacyAnchor("survey"), "survey");
  assert.equal(legacyAnchor("review"), null);
});
test("next and back", () => {
  assert.equal(nextStep("webinar"), "messages");
  assert.equal(nextStep("messages"), null);
  assert.equal(prevStep("webinar"), null);
  assert.equal(prevStep("messages"), "webinar");
});

console.log("\nissues");
test("a complete webinar has none", () => {
  assert.deepEqual(ids(ok), []);
});
test("topic and time block step 1, and nothing blocks step 2", () => {
  const issues = scheduleIssues({ ...ok, topic: "  ", startsAt: null });
  assert.deepEqual(issuesFor(issues, "webinar").map((i) => i.id), ["topic", "when"]);
  assert.equal(issues[0].target, "topic");
  assert.equal(issues[1].target, "date");
  assert.deepEqual(issuesFor(issues, "messages"), []);
});
test("a past start blocks a new webinar only, and waits for the clock", () => {
  const past = { ...ok, startsAt: new Date(NOW - 60_000) };
  assert.deepEqual(ids(past), ["when-past"]);
  assert.deepEqual(ids({ ...past, editing: true }), []);
  assert.deepEqual(ids({ ...past, now: null }), []);
});
test("survey, questions and a bad watch link block, in page order", () => {
  const issues = scheduleIssues({
    ...ok,
    surveyProblem: "x",
    questionProblem: "Add at least two choices.",
    multistream: true,
    watchUrl: "youtu.be/abc",
  });
  assert.deepEqual(issues.map((i) => i.id), ["questions", "watch-url", "survey"]);
  assert.deepEqual(ids({ ...ok, multistream: false, watchUrl: "youtu.be/abc" }), []);
  assert.deepEqual(ids({ ...ok, multistream: true, watchUrl: "https://youtu.be/abc" }), []);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
