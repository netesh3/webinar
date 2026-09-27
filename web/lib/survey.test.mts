/* Post-event survey: the builder's validation (mirroring internal/survey), the attendee card's
 * submit rules, when the room shows it, and the results page's arithmetic.
 *
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import type { AudienceSurvey, Survey } from "./api-types.ts";
import {
  LIMITS,
  barWidths,
  cleanInput,
  dismissalKey,
  draftProblem,
  emptyDraft,
  emptyInput,
  isDone,
  moveItem,
  previewSurvey,
  scaleFor,
  sendSummary,
  shares,
  suggestedSendMinute,
  starLabel,
  surveyMoment,
  toAnswers,
  toInput,
  urlProblem,
  validateInput,
} from "./survey.ts";

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

const survey = (over: Partial<Survey> = {}): Survey => ({
  id: "s1",
  mode: "builtin",
  title: "",
  buttonLabel: "",
  externalUrl: "",
  askRating: true,
  status: "live",
  sendAt: "on_end",
  sendAfterMin: 0,
  questions: [
    { id: "nps", kind: "nps_10", prompt: "Recommend?", required: true, options: [] },
    { id: "pace", kind: "single_choice", prompt: "Pace", required: false, options: ["Slow", "Right", "Fast"] },
    { id: "more", kind: "text", prompt: "Anything else?", required: false, options: [] },
  ],
  updatedAt: "",
  responses: 0,
  linkClicks: 0,
  locked: false,
  launchedAt: "2026-09-27T10:00:00Z",
  ...over,
});

const aud = (over: Partial<AudienceSurvey> = {}): AudienceSurvey => ({
  survey: survey(),
  live: true,
  mine: { submitted: false, linkClicked: false },
  ...over,
});

console.log("\nbuilder");
test("urls: https only, no credentials, no spaces, a real host", () => {
  assert.equal(urlProblem("https://forms.gle/abc"), null);
  assert.equal(urlProblem(" https://docs.google.com/forms/d/x/viewform "), null);
  assert.match(urlProblem("http://forms.gle/x")!, /https/);
  assert.match(urlProblem("javascript:alert(1)")!, /https/);
  assert.ok(urlProblem("https://u:p@forms.gle/x"));
  assert.ok(urlProblem("https://forms.gle/a b"));
  assert.ok(urlProblem("https://localhost/x"));
  assert.ok(urlProblem(""));
  assert.ok(urlProblem("https://a.co/" + "x".repeat(LIMITS.url)));
});
test("a fresh builtin survey validates; blank prompts and short choices do not", () => {
  assert.deepEqual(validateInput(emptyInput()), {});
  const i = emptyInput();
  i.questions = [
    { kind: "text", prompt: "   ", required: false },
    { kind: "single_choice", prompt: "Pick", required: false, options: ["one", "  "] },
  ];
  const errs = validateInput(i);
  assert.ok(errs["questions.0"] && errs["questions.1"]);
});
test("more than five questions is refused", () => {
  const i = emptyInput();
  i.questions = Array.from({ length: 6 }, () => ({ kind: "text", prompt: "Q", required: false }));
  assert.ok(validateInput(i).questions);
});
test("link mode checks only the link and labels", () => {
  const i = { ...emptyInput(), mode: "link", externalUrl: "https://forms.gle/x" };
  assert.deepEqual(validateInput(i), {});
  assert.ok(validateInput({ ...i, buttonLabel: "b".repeat(LIMITS.button + 1) }).buttonLabel);
});
test("clean input drops questions in link mode and forces the rating in builtin", () => {
  const link = cleanInput({ ...emptyInput(), mode: "link", askRating: false, externalUrl: " https://a.co/x " });
  assert.equal(link.questions.length, 0);
  assert.equal(link.externalUrl, "https://a.co/x");
  assert.equal(link.askRating, false);
  const b = cleanInput({ ...emptyInput(), askRating: false, title: "  Hi   there " });
  assert.equal(b.askRating, true);
  assert.equal(b.title, "Hi there");
  assert.equal(b.externalUrl, "");
});
test("toInput keeps question ids so answers stay attached", () => {
  const i = toInput(survey());
  assert.deepEqual(i.questions.map((q) => q.id), ["nps", "pace", "more"]);
  assert.deepEqual(i.questions[0].options, []);
});
test("moveItem reorders and ignores out-of-range moves", () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, 2), [2, 3, 1]);
  assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
});
test("preview fills untitled questions", () => {
  const p = previewSurvey({ ...emptyInput(), questions: [{ kind: "text", prompt: "", required: false }] });
  assert.equal(p.questions[0].prompt, "Untitled question");
});

console.log("\nattendee");
test("the rating and required questions gate Submit", () => {
  const s = survey();
  assert.match(draftProblem(s, emptyDraft())!, /star/);
  assert.match(draftProblem(s, { rating: 4, answers: {} })!, /Recommend/);
  assert.equal(draftProblem(s, { rating: 4, answers: { nps: 0 } }), null, "0 is an answer");
  assert.match(draftProblem(s, { rating: 4, answers: { nps: 9, more: "x".repeat(LIMITS.text + 1) } })!, /under/);
});
test("link mode asks only the rating, and only when enabled", () => {
  const link = survey({ mode: "link", questions: [] });
  assert.ok(draftProblem(link, emptyDraft()));
  assert.equal(draftProblem({ ...link, askRating: false }, emptyDraft()), null);
  assert.deepEqual(toAnswers(link, { rating: 5, answers: { x: 1 } }), []);
});
test("answers skip blanks and keep survey order", () => {
  const body = toAnswers(survey(), { rating: 3, answers: { more: "  hi ", nps: 7, pace: undefined } });
  assert.deepEqual(body, [
    { questionId: "nps", number: 7 },
    { questionId: "more", text: "hi" },
  ]);
});
test("scales and star labels", () => {
  assert.equal(scaleFor(survey().questions[0]).length, 11);
  assert.deepEqual(scaleFor(survey().questions[1]), [0, 1, 2]);
  assert.equal(starLabel(1), "Poor");
  assert.equal(starLabel(5), "Excellent");
  assert.equal(starLabel(0), "");
});

console.log("\nwhen it shows");
test("live and unanswered pops up; dismissed waits for leaving; answered never shows", () => {
  assert.equal(surveyMoment(aud(), false), "popup");
  assert.equal(surveyMoment(aud(), true), "leave");
  assert.equal(surveyMoment(aud({ live: false }), false), "leave");
  assert.equal(surveyMoment(aud({ mine: { submitted: true, linkClicked: false } }), false), "none");
  assert.equal(surveyMoment(aud({ survey: undefined }), false), "none");
  assert.equal(surveyMoment(null, false), "none");
});
test("a link survey without a rating is done once opened", () => {
  const a = aud({ survey: survey({ mode: "link", askRating: false }), mine: { submitted: false, linkClicked: true } });
  assert.ok(isDone(a));
  assert.ok(!isDone({ ...a, survey: survey({ mode: "link", askRating: true }) }));
});
test("dismissal is per launch, so a relaunch asks again", () => {
  assert.notEqual(dismissalKey(survey()), dismissalKey(survey({ launchedAt: "2026-09-27T11:00:00Z" })));
  assert.equal(dismissalKey(undefined), null);
});

console.log("\nresults");
test("shares add to 100 and bars scale to the largest", () => {
  const s = shares([1, 1, 1]);
  assert.equal(s.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(shares([0, 0]), [0, 0]);
  assert.deepEqual(barWidths([0, 2, 4]), [0, 50, 100]);
  assert.deepEqual(barWidths([0, 0]), [0, 0]);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

// Timing: "at a set time" needs a minute; the other two carry none on the wire.
{
  const base = { ...emptyInput(), sendAt: "at_minute" as const };
  assert.equal(emptyInput().sendAt, "manual", "the recommended way is the default");
  assert.ok(validateInput({ ...base, sendAfterMin: 0 }).sendAfterMin);
  assert.ok(validateInput({ ...base, sendAfterMin: 601 }).sendAfterMin);
  assert.equal(validateInput({ ...base, sendAfterMin: 50 }).sendAfterMin, undefined);
  assert.equal(cleanInput({ ...emptyInput(), sendAt: "on_end", sendAfterMin: 50 }).sendAfterMin, 0);
  assert.equal(cleanInput({ ...base, sendAfterMin: 50 }).sendAfterMin, 50);
  assert.equal(suggestedSendMinute(60), 50);
  assert.equal(suggestedSendMinute(5), 1);
  assert.equal(sendSummary({ sendAt: "at_minute", sendAfterMin: 50 }), "Pops up 50 min in");
}
