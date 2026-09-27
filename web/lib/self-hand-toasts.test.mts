/* Tests for the requester's own hand and stage toast: states replacing each other under one
 * key, what a hand coming down means depending on who lowered it, and how long each stays.
 *
 * Run with `make test-web`.
 */

import {
  SELF_HAND_GRACE_MS,
  SELF_HAND_MS,
  SelfHandTracker,
  selfHandActions,
  selfHandText,
  type SelfHandView,
} from "./self-hand-toasts.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL  ${what}${detail ? `\n      ${detail}` : ""}`);
}

function phase(t: SelfHandTracker): string {
  const v = t.view();
  if (!v) return "none";
  return v.phase === "stage" ? `stage:${v.arrival}` : v.phase;
}

function eq(t: SelfHandTracker, want: string, what: string): void {
  const got = phase(t);
  ok(got === want, what, `want ${want}, got ${got}`);
}

function fresh(raised = false): SelfHandTracker {
  const t = new SelfHandTracker();
  t.hand(raised, 0);
  return t;
}

const invite = { audioOnly: true, recording: false };
const RAISED_MS = SELF_HAND_MS.raised ?? 0;
const DISMISSED_MS = SELF_HAND_MS.dismissed ?? 0;

// ---- baseline ---------------------------------------------------------------

{
  const t = new SelfHandTracker();
  t.hand(true, 0);
  eq(t, "none", "a hand already up when the room mounts is not announced");
  t.hand(true, 10);
  eq(t, "none", "the same reading again is not news");
}

// ---- raising and lowering your own hand ---------------------------------------

{
  const t = fresh();
  t.hand(true, 100);
  eq(t, "raised", "raising your hand confirms it");
  t.hand(false, 200);
  eq(t, "lowered", "lowering it yourself replaces the same card");
  t.hand(true, 300);
  eq(t, "raised", "and raising again brings it back");
}

// ---- the host lowering it -------------------------------------------------------

{
  const t = fresh();
  t.hand(true, 100);
  t.lowered("dismissed", 200);
  eq(t, "dismissed", "a dismissal replaces 'raised' in place");
  // The packet is handled before the next render reads the hand as down.
  t.hand(false, 210);
  eq(t, "dismissed", "the hand reading that follows a dismissal does not say 'you lowered it'");
}

{
  const t = fresh();
  t.hand(true, 100);
  t.lowered("cleared", 200);
  eq(t, "cleared", "Lower all hands tells somebody whose hand was up");
  t.hand(false, 210);
  eq(t, "cleared", "…once");
}

{
  const t = fresh();
  t.lowered("cleared", 200);
  eq(t, "none", "Lower all hands says nothing to somebody whose hand was down");
}

{
  const t = fresh();
  t.hand(true, 100);
  t.lowered("granted", 200);
  eq(t, "none", "a granted hand clears 'raised' and leaves the stage change to announce itself");
  t.hand(false, 210);
  eq(t, "none", "and is not reported as lowered by you");
}

// ---- invitations -----------------------------------------------------------------

{
  const t = fresh();
  t.hand(true, 100);
  t.invite(invite, 200);
  eq(t, "invited", "an invite replaces 'raised'");
  t.hand(false, 250);
  eq(t, "invited", "the hand's own bookkeeping does not talk over an open invite");
  t.lowered("dismissed", 260);
  eq(t, "invited", "nor does a dismissal that crosses it");
  ok(t.nextDeadline() === null, "an open invite does not time out");
  t.tick(1_000_000);
  eq(t, "invited", "…even much later");
  t.invite(null, 1_000_001);
  eq(t, "none", "withdrawn or answered, it goes");
}

{
  const t = fresh();
  t.invite(invite, 100);
  const before = t.view();
  t.invite({ ...invite }, 200);
  ok(t.view() === before, "the same invite again is not redrawn");
}

{
  const t = fresh();
  t.invite(invite, 100);
  t.accepted(200);
  eq(t, "stage:joining", "accepting shows 'Joining the stage…'");
  t.invite(null, 210);
  eq(t, "stage:joining", "and the invite clearing does not take it down");
  t.stage("speak", 300);
  eq(t, "stage:speak", "the grant arriving replaces it");
}

{
  const t = fresh();
  t.invite(invite, 100);
  t.stage("speak", 150);
  t.accepted(200);
  eq(t, "stage:speak", "a grant that beat the accept response is not overwritten by 'joining'");
}

{
  const t = fresh();
  t.invite(invite, 100);
  t.accepted(200, "stage");
  eq(t, "stage:stage", "the CDN audience says 'on stage' itself, before it remounts");
}

// ---- stage and audience ------------------------------------------------------------

{
  const t = fresh();
  t.stage("stage", 100);
  eq(t, "stage:stage", "arriving on stage");
  t.hand(true, 150);
  eq(t, "stage:stage", "a hand going up does not talk over 'you're on stage'");
  t.hand(false, 160);
  eq(t, "stage:stage", "nor does it coming down");
  t.audience(200);
  eq(t, "audience", "moved back to the audience replaces it");
  t.hand(true, 300);
  eq(t, "raised", "a hand raised from the audience replaces that");
}

// ---- timing -------------------------------------------------------------------------

{
  const t = fresh();
  t.hand(true, 1000);
  ok(t.nextDeadline() === 1000 + RAISED_MS, "'raised' has its own timeout");
  ok(!t.tick(1000 + RAISED_MS - 1), "not before it");
  ok(t.tick(1000 + RAISED_MS), "and goes at it");
  eq(t, "none", "gone");
}

{
  const t = fresh();
  t.hand(true, 0);
  t.lowered("dismissed", 100);
  ok(t.nextDeadline() === 100 + DISMISSED_MS, "the dismissal's clock starts when it replaced 'raised'");
  ok(DISMISSED_MS > (SELF_HAND_MS.lowered ?? 0), "the card with a button stays longer than the plain confirmation");
}

{
  const t = fresh();
  t.hand(true, 0);
  t.lowered("dismissed", 0);
  t.hold(true, 1000);
  ok(t.nextDeadline() === null, "held under a pointer, it does not time out");
  ok(!t.tick(100_000), "…at all");
  t.hold(false, 100_000);
  ok(t.nextDeadline() === 100_000 + SELF_HAND_GRACE_MS, "released late, it gets the grace period");
  t.tick(100_000 + SELF_HAND_GRACE_MS);
  eq(t, "none", "and then goes");
}

{
  const t = fresh();
  t.hand(true, 0);
  t.hold(true, 100);
  t.hold(false, 200);
  ok(t.nextDeadline() === RAISED_MS, "released early, the original deadline stands");
}

{
  const t = fresh();
  t.hand(true, 0);
  t.hold(true, 100);
  t.lowered("dismissed", 200);
  ok(t.nextDeadline() === 200 + DISMISSED_MS, "a new state is not born held");
}

{
  const t = fresh();
  t.hand(true, 0);
  t.dismiss();
  eq(t, "none", "closed by the person");
  ok(t.nextDeadline() === null, "nothing pending");
}

// ---- copy and actions ------------------------------------------------------------------

{
  const d = selfHandText({ phase: "dismissed" });
  ok(!/dismiss|reject|denied|declin/i.test(`${d.title} ${d.detail}`), "the dismissal does not read as a rejection", d.title);
  ok(/for now/.test(d.title), "…and keeps 'for now' from the original copy", d.title);
  ok(/raise it again/i.test(d.detail), "…and says the hand can go up again");
  ok(!/raise it again/i.test(selfHandText({ phase: "dismissed" }, { canRaise: false }).detail), "…unless raise hand is off");
  ok(d.tone === "info", "…in a neutral tone");

  ok(selfHandText({ phase: "raised" }).title === "Your hand is raised", "raised title");
  ok(selfHandText({ phase: "stage", arrival: "stage" }).tone === "ok", "on stage is positive");
  ok(/microphone and camera/.test(selfHandText({ phase: "stage", arrival: "stage" }).detail), "on stage says where the controls are");
  ok(/Unmute/.test(selfHandText({ phase: "stage", arrival: "speak" }).detail), "audio-only says to unmute");
  ok(selfHandText({ phase: "audience" }).tone === "info", "back to the audience is neutral");

  const inv = (o: Partial<typeof invite>, rec = false) =>
    selfHandText({ phase: "invited", invite: { ...invite, ...o } }, { recording: rec }).detail;
  ok(/hear you\./.test(inv({})) && !/see/.test(inv({})), "an audio invite says you will be heard");
  ok(/see and hear/.test(inv({ audioOnly: false })), "a camera invite says you will be seen");
  ok(/recorded/.test(inv({ recording: true })), "the invite's own recording flag is said");
  ok(/recorded/.test(inv({}, true)), "so is the room's");
  ok(!/recorded/.test(inv({})), "and neither when not recording");

  const all: SelfHandView[] = [
    { phase: "raised" },
    { phase: "lowered" },
    { phase: "dismissed" },
    { phase: "cleared" },
    { phase: "invited", invite },
    { phase: "stage", arrival: "stage" },
    { phase: "stage", arrival: "back" },
    { phase: "stage", arrival: "speak" },
    { phase: "stage", arrival: "joining" },
    { phase: "audience" },
  ];
  for (const v of all) {
    const text = selfHandText(v);
    ok(text.title.length > 0 && text.detail.length > 0, `copy for ${v.phase}`);
  }

  ok(selfHandActions({ phase: "raised" }).lower, "raised offers Lower hand");
  ok(selfHandActions({ phase: "dismissed" }).raise, "dismissed offers Raise again");
  ok(selfHandActions({ phase: "cleared" }).raise, "cleared offers Raise again");
  ok(!selfHandActions({ phase: "dismissed" }, { canRaise: false }).raise, "…not when raise hand is off");
  const i = selfHandActions({ phase: "invited", invite });
  ok(i.accept && i.decline && !i.close, "an invite is answered, not closed past");
  const s = selfHandActions({ phase: "stage", arrival: "stage" });
  ok(!s.lower && !s.raise && !s.accept && s.close, "on stage has only the close");
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`self-hand-toasts: ${checks} checks passed`);
