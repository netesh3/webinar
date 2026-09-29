/* Tests for the raised-hand toasts ("Asha wants to speak").
 *
 * Run with `make test-web`.
 *
 * Every case is about timing or about who took a hand down — a burst of hands, a
 * co-host arriving mid-queue, another host handling the request in the panel, a
 * flapping hand — which a live room will not produce on demand.
 */

import {
  HAND_INFO_MS,
  HAND_SUMMARY_KEY,
  HAND_TOAST_MS,
  HOLD_GRACE_MS,
  HandTracker,
  INVITED_LINGER_MS,
  REPEAT_QUIET_MS,
  handActions,
  handAudience,
  handKey,
  handPersonText,
  handSummaryText,
  type HandPerson,
  type HandToastView,
} from "./hand-toasts.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

const T = 1_700_000_000_000;
const ME = "user_me";

function att(identity: string, name = identity, raisedAt = T): HandPerson {
  return { identity, name, role: "attendee", raisedAt };
}
function pan(identity: string, name = identity, raisedAt = T): HandPerson {
  return { identity, name, role: "panelist", raisedAt };
}

function shown(views: HandToastView[]): string[] {
  return views.map((v) =>
    v.kind === "person" ? `${v.entry.identity}:${v.entry.phase}` : `summary:${v.entries.map((e) => e.identity).join(",")}`,
  );
}

function ready(already: HandPerson[] = [], timeout?: number): HandTracker {
  const t = new HandTracker(ME, timeout);
  t.hands(already, T);
  return t;
}

console.log("audience and actions");
{
  eq(handAudience({ isHost: true, role: "host" }), "act", "the host acts");
  eq(handAudience({ isHost: true, role: "panelist" }), "act", "a co-host acts — isHost already includes them");
  eq(handAudience({ isHost: false, role: "panelist" }), "inform", "an ordinary panelist is told, with nothing to press");
  eq(handAudience({ isHost: false, role: "attendee" }), null, "attendees are never told about each other's hands");

  eq(
    handActions("act", { role: "attendee", phase: "raised" }),
    { allow: true, lower: true, view: true },
    "an attendee's hand: allow, lower, view — as the roster row",
  );
  eq(
    handActions("act", { role: "panelist", phase: "raised" }),
    { allow: false, lower: true, view: true },
    "a panelist's hand: no Allow to speak, they already can",
  );
  eq(
    handActions("act", { role: "attendee", phase: "invited" }),
    { allow: false, lower: false, view: true },
    "once invited, nothing left to press but View",
  );
  eq(
    handActions("inform", { role: "attendee", phase: "raised" }),
    { allow: false, lower: false, view: false },
    "a panelist's heads-up has no buttons",
  );
}

console.log("\nraise → toast → handled elsewhere");
{
  const t = ready();
  t.hands([att("att_a", "Asha", T + 100)], T + 100);
  eq(shown(t.view()), ["att_a:raised"], "a new hand is a toast");
  eq(t.view()[0]?.key, handKey("att_a"), "keyed per person, so it updates in place");
  t.hands([att("att_a", "Asha", T + 100)], T + 2000);
  eq(shown(t.view()), ["att_a:raised"], "the same list again is not a second toast");
  t.hands([], T + 3000);
  eq(shown(t.view()), [], "gone from the list — lowered by anyone, or they left — is gone from the toast");
  eq(t.nextDeadline(), null, "nothing to wake up for");
}

console.log("\nbaseline");
{
  const t = ready([att("att_a", "Asha"), att("att_b", "Ravi")]);
  eq(shown(t.view()), [], "hands already up when the viewer started looking are not news");
  t.hands([att("att_a", "Asha"), att("att_b", "Ravi")], T + 1000);
  eq(shown(t.view()), [], "nor on the next reading (a reconnect re-reading the same list)");
  t.hands([att("att_a", "Asha"), att("att_b", "Ravi"), att("att_c", "Meera", T + 2000)], T + 2000);
  eq(shown(t.view()), ["att_c:raised"], "a hand raised after the baseline is");
}

console.log("\nnot yourself");
{
  const t = ready();
  t.hands([pan(ME, "Me")], T + 100);
  eq(shown(t.view()), [], "your own hand never toasts you");
}

console.log("\ntimeout");
{
  const t = ready();
  t.hands([att("att_a", "Asha")], T);
  eq(t.nextDeadline(), T + HAND_TOAST_MS, "an actionable toast lasts HAND_TOAST_MS");
  ok(!t.tick(T + HAND_TOAST_MS - 1), "still up just before");
  ok(t.tick(T + HAND_TOAST_MS), "tick reports the expiry");
  eq(shown(t.view()), [], "gone — the hand is still in the queue and on the badge");
  t.hands([att("att_a", "Asha")], T + HAND_TOAST_MS + 5000);
  eq(shown(t.view()), [], "and it is not re-announced while it stays up");

  const info = ready([], HAND_INFO_MS);
  info.hands([att("att_a", "Asha")], T);
  eq(info.nextDeadline(), T + HAND_INFO_MS, "a panelist's heads-up is shorter");
}

console.log("\nhold under the pointer");
{
  const t = ready();
  t.hands([att("att_a", "Asha")], T);
  t.hold(["att_a"], true, T + 1000);
  eq(t.nextDeadline(), null, "a held toast has no deadline");
  ok(!t.tick(T + HAND_TOAST_MS * 3), "and does not expire while held");
  t.hold(["att_a"], false, T + HAND_TOAST_MS * 3);
  eq(t.nextDeadline(), T + HAND_TOAST_MS * 3 + HOLD_GRACE_MS, "released late, it gets the grace period");
}
{
  const t = ready();
  t.hands([att("att_a", "Asha")], T);
  t.hold(["att_a"], true, T + 1000);
  t.hold(["att_a"], false, T + 2000);
  eq(t.nextDeadline(), T + HAND_TOAST_MS, "released early, it keeps its original deadline");
}

console.log("\ninvited");
{
  const t = ready();
  t.hands([att("att_a", "Asha")], T);
  t.invited("att_a", T + 3000);
  eq(shown(t.view()), ["att_a:invited"], "Allow to speak that sent an invite keeps the toast, as 'invited'");
  eq(t.nextDeadline(), T + 3000 + INVITED_LINGER_MS, "briefly");
  t.tick(T + 3000 + INVITED_LINGER_MS);
  eq(shown(t.view()), [], "then goes, though the hand is up until they accept");
  t.hands([att("att_a", "Asha")], T + 10_000);
  eq(shown(t.view()), [], "and does not come back for the same hand");
}

console.log("\ndismiss");
{
  const t = ready();
  t.hands([att("att_a", "Asha")], T);
  t.dismiss(["att_a"]);
  eq(shown(t.view()), [], "closed by the viewer");
  t.hands([att("att_a", "Asha")], T + 1000);
  eq(shown(t.view()), [], "the hand is still up, so it is not announced again");
  t.hands([], T + 2000);
  t.hands([att("att_a", "Asha", T + 20_000)], T + 20_000);
  eq(shown(t.view()), ["att_a:raised"], "lowered and raised again later is a new request");
}

console.log("\nflapping");
{
  const t = ready();
  t.hands([att("att_a", "Asha")], T);
  t.dismiss(["att_a"]);
  t.hands([], T + 1000);
  t.hands([att("att_a", "Asha")], T + 1000 + REPEAT_QUIET_MS - 1);
  eq(shown(t.view()), [], "down and up again inside REPEAT_QUIET_MS is the same hand");
  t.hands([], T + 10_000);
  t.tick(T + 10_000 + REPEAT_QUIET_MS);
  t.hands([att("att_a", "Asha")], T + 10_000 + REPEAT_QUIET_MS);
  eq(shown(t.view()), ["att_a:raised"], "after the quiet window it is a fresh raise");
}

console.log("\nbatching");
{
  const t = ready();
  const a = att("att_a", "Asha", T + 1);
  const b = att("att_b", "Ravi", T + 2);
  const c = att("att_c", "Meera", T + 3);
  t.hands([a], T + 1);
  t.hands([a, b], T + 2);
  eq(shown(t.view()), ["att_a:raised", "att_b:raised"], "two hands are two cards");
  t.hands([a, b, c], T + 3);
  eq(shown(t.view()), ["summary:att_a,att_b,att_c"], "a third folds all of them into one summary");
  eq(t.view()[0]?.key, HAND_SUMMARY_KEY, "under one key");
  const summary = t.view()[0];
  if (summary?.kind === "summary") {
    eq(
      handSummaryText(summary.entries),
      { title: "3 people raised their hands", detail: "Asha, Ravi and Meera" },
      "the summary says how many, then who",
    );
  }
  t.hands([a, c], T + 4);
  eq(shown(t.view()), ["summary:att_a,att_c"], "one handled out of the burst leaves the summary folded");
  t.hands([c], T + 5);
  eq(shown(t.view()), ["att_c:raised"], "down to one, it is a card again");
}
{
  const t = ready();
  const burst = [1, 2, 3, 4].map((i) => att(`att_${i}`, `P${i}`, T + i));
  t.hands(burst, T + 1000);
  eq(t.nextDeadline(), T + 1000 + HAND_TOAST_MS, "the summary expires as one");
  t.hands([...burst, att("att_5", "P5", T + 6000)], T + 6000);
  eq(t.nextDeadline(), T + 6000 + HAND_TOAST_MS, "a newcomer keeps the summary up");
  ok(t.tick(T + 6000 + HAND_TOAST_MS), "and it goes together");
  eq(shown(t.view()), [], "all at once, not one name at a time");
}

console.log("\nwording");
{
  const raised = { ...att("att_a", "Asha"), shownAt: T, phase: "raised" as const };
  eq(handPersonText(raised, "act"), "Asha wants to speak", "to a host, an attendee's hand is a request to speak");
  eq(
    handPersonText({ ...raised, role: "panelist" }, "act"),
    "Asha raised their hand",
    "a panelist's hand is just a hand",
  );
  eq(handPersonText(raised, "inform"), "Asha raised their hand", "a panelist viewer is told the plain fact");
  eq(
    handPersonText({ ...raised, phase: "invited" }, "act"),
    "Invited Asha to speak — waiting for them to accept",
    "invited",
  );
  eq(handSummaryText([raised]).title, "1 person raised their hand", "singular");
}

console.log("\nroster catching up");
{
  const t = ready();
  t.hands([att("att_a", "att_a")], T);
  t.hands([{ ...att("att_a", "Asha"), role: "panelist", coHost: false }], T + 500);
  const v = t.view()[0];
  ok(v?.kind === "person" && v.entry.name === "Asha" && v.entry.role === "panelist", "a later reading updates the name and role");
  ok(v?.kind === "person" && v.entry.shownAt === T, "without restarting the timeout");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
