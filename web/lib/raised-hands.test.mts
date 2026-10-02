/* Raised-hands queue: the Participants count, who sees the button, and the
 * actions that have to hit the existing hand and stage helpers.
 *
 * Run with `make test-web`.
 */

import {
  beginRaisedHands,
  chatFocusDraft,
  dismissRaisedHands,
  endRaisedHands,
  handAlreadyOnStage,
  inviteHandToSpeak,
  lowerAllHands,
  lowerOneHand,
  messageRaisedHandTarget,
  orderedRaisedHands,
  participantsButtonCount,
  raisedAgoLabel,
  raisedHandsButtonCount,
  raisedHandsPlacement,
  type RaisedHandsViewer,
} from "./raised-hands.ts";

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

const host: RaisedHandsViewer = { isHost: true, role: "host", promoted: false, canPublish: true };
const panelist: RaisedHandsViewer = {
  isHost: false,
  role: "panelist",
  promoted: false,
  canPublish: true,
};
const attendee: RaisedHandsViewer = {
  isHost: false,
  role: "attendee",
  promoted: false,
  canPublish: false,
};
const promoted: RaisedHandsViewer = {
  isHost: false,
  role: "panelist",
  promoted: true,
  canPublish: true,
};

console.log("\nparticipants count");

eq(participantsButtonCount(24, 3), 24, "headcount stays when hands are raised");
eq(participantsButtonCount(24, 0), 24, "headcount stays when nobody has a hand up");
eq(
  participantsButtonCount(undefined, 5),
  undefined,
  "a missing headcount is not replaced by the hand count",
);

console.log("\nraised-hands button");

eq(raisedHandsButtonCount(host, 0), null, "hidden for the host when nobody has a hand up");
eq(raisedHandsButtonCount(host, 3), 3, "visible for the host with the hand count");
eq(raisedHandsButtonCount(panelist, 2), 2, "visible for a panelist with the hand count");
eq(raisedHandsButtonCount(panelist, 0), null, "hidden for a panelist at zero");
eq(raisedHandsButtonCount(attendee, 4), null, "hidden for an attendee even when hands are up");
eq(raisedHandsButtonCount(promoted, 4), null, "hidden for an attendee who was allowed to speak");

eq(raisedHandsPlacement(false, 3), "bar", "desktop shows the button on the bar");
eq(raisedHandsPlacement(true, 3), "overflow", "a narrow bar puts it with the overflow tools");
eq(raisedHandsPlacement(false, null), "hidden", "no count means no button");
eq(raisedHandsPlacement(true, null), "hidden", "no count means no overflow entry either");

console.log("\nqueue order and time");

eq(
  orderedRaisedHands([
    { identity: "b", at: 200 },
    { identity: "a", at: 100 },
    { identity: "c", at: 100 },
  ]).map((h) => h.identity),
  ["a", "c", "b"],
  "earliest raised first, identity as the tie break",
);
eq(raisedAgoLabel(1_000, 16_000), "raised 15s ago", "seconds under a minute");
eq(raisedAgoLabel(0, 80_000), "raised 1m 20s ago", "minutes and leftover seconds");
eq(raisedAgoLabel(undefined, 10_000), null, "no timestamp means no invented clock");

console.log("\nactions");

{
  const calls: string[] = [];
  await lowerOneHand(async (identity, reason) => {
    calls.push(`${identity}:${reason}`);
  }, "att-1");
  eq(calls, ["att-1:dismissed"], "lower one calls the existing lower-hand API");
}

{
  const calls: string[] = [];
  await lowerAllHands(async () => {
    calls.push("clear");
  });
  eq(calls, ["clear"], "lower all calls the existing clear-hands API");
}

{
  const calls: string[] = [];
  const outcome = await inviteHandToSpeak(
    async (slug, _lower, identity, role, audioOnly, handUp) => {
      calls.push(`${slug}:${identity}:${role}:${audioOnly}:${handUp}`);
      return "invited";
    },
    {
      slug: "demo",
      lowerHand: async () => undefined,
      identity: "att-1",
      alreadyOnStage: false,
    },
  );
  eq(outcome, "invited", "invite returns the promotion result");
  eq(
    calls,
    ["demo:att-1:panelist:true:true"],
    "invite calls the existing allow-to-speak promotion",
  );
}

{
  let called = false;
  const outcome = await inviteHandToSpeak(
    async () => {
      called = true;
      return "done";
    },
    {
      slug: "demo",
      lowerHand: async () => undefined,
      identity: "p-1",
      alreadyOnStage: true,
    },
  );
  eq(outcome, "skipped", "someone already on stage is not promoted again");
  ok(!called, "the promotion helper is not called for someone already on stage");
  ok(handAlreadyOnStage({ role: "panelist" }), "a panelist counts as already on stage");
  ok(!handAlreadyOnStage(undefined), "an unknown person can still be invited");
}

eq(messageRaisedHandTarget(), "room-chat", "there is no per-person DM, so message opens room chat");
{
  const draft = chatFocusDraft({ identity: "att-1", name: "Priya Shah" });
  ok(draft.text.startsWith("@Priya Shah"), "room chat is addressed with an @mention", draft.text);
  eq(draft.mentions[0]?.identity, "att-1", "the mention is that person");
}

console.log("\ndrawer session");

{
  const opened = beginRaisedHands("chat");
  eq(opened, { open: true, restore: "chat" }, "opening remembers the panel it covered");
  const closed = endRaisedHands(opened);
  eq(closed.restore, "chat", "closing restores that panel");
  eq(closed.session, { open: false, restore: null }, "the queue is shut after close");
  eq(dismissRaisedHands(), { open: false, restore: null }, "yielding to another panel does not restore");
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
