/* Tests for a simulive's room states: the countdown's target, which view shows, the doors,
 * and which host controls show per state. Run with `make test-web`. */

import assert from "node:assert/strict";
import {
  countdownTarget,
  doorsOpenAtMs,
  hostControls,
  liveWithLabel,
  msUntilFinished,
  simuliveView,
  waitingCount,
} from "./simulive-host.ts";

const now = Date.parse("2026-10-22T10:00:00Z");
const at = (min: number) => new Date(now + min * 60_000).toISOString();

// ---- countdown target
assert.equal(countdownTarget(at(10), null, false), at(10), "auto: the scheduled start");
assert.equal(countdownTarget(at(10), null, true), null, "manual: waits for the host");
assert.equal(countdownTarget(at(10), at(2), true), at(2), "a pending start wins, manual");
assert.equal(countdownTarget(at(10), at(15), false), at(15), "a delay wins, auto");
assert.equal(countdownTarget(at(10), "garbage", false), at(10), "an unreadable pending start is ignored");

// ---- which view the room shows
assert.equal(simuliveView({ nowMs: now }), "waiting");
assert.equal(simuliveView({ startedAt: at(-1), lengthMs: 300_000, nowMs: now }), "playing");
assert.equal(simuliveView({ startedAt: at(-5), lengthMs: 300_000, nowMs: now }), "finished", "at the end: nothing plays");
assert.equal(simuliveView({ startedAt: at(-50), nowMs: now }), "playing", "no length known: plays on");
assert.equal(simuliveView({ startedAt: at(-6), lengthMs: 300_000, liveAt: at(0), nowMs: now }), "live");
assert.equal(simuliveView({ status: "ended", startedAt: at(-6), liveAt: at(0), nowMs: now }), "ended");
assert.equal(msUntilFinished(at(-1), 300_000, now), 240_000);
assert.equal(msUntilFinished(at(-6), 300_000, now), null);
assert.equal(msUntilFinished(null, 300_000, now), null);

// ---- doors
assert.equal(doorsOpenAtMs({ startsAt: at(30), doorsOpenMin: 10 }), now + 20 * 60_000);
assert.equal(doorsOpenAtMs({ startsAt: at(30), pendingStartAt: at(5), doorsOpenMin: 10 }), now - 5 * 60_000, "an earlier start brings the doors forward");
assert.equal(doorsOpenAtMs({ startsAt: at(30), pendingStartAt: at(40), doorsOpenMin: 10 }), now + 20 * 60_000, "a delay does not shut them");
assert.equal(doorsOpenAtMs({ startsAt: at(30), doorsOpenMin: 10, doorsOpen: true }), null);

// ---- host controls per state
{
  const manualEarly = hostControls({ view: "waiting", manual: true, startsAt: at(30), doorsOpenMin: 10, nowMs: now });
  assert.deepEqual(
    { ...manualEarly, startIn: [...manualEarly.startIn] },
    { startNow: true, startIn: [2, 5, 10], delay: false, cancel: false, openDoors: true, end: false },
    "manual, nothing pending, doors shut",
  );
  const manualPending = hostControls({ view: "waiting", manual: true, startsAt: at(30), pendingStartAt: at(2), doorsOpenMin: 10, nowMs: now });
  assert.equal(manualPending.cancel, true);
  assert.equal(manualPending.delay, true);
  assert.equal(manualPending.openDoors, false, "the pending start opened them");

  const auto = hostControls({ view: "waiting", manual: false, startsAt: at(5), doorsOpenMin: 10, nowMs: now });
  assert.equal(auto.delay, true, "auto can be postponed");
  assert.equal(auto.cancel, false, "nothing to cancel");
  assert.equal(auto.openDoors, false, "already open");

  const autoDelayedPastDue = hostControls({ view: "waiting", manual: false, startsAt: at(-1), pendingStartAt: at(4), doorsOpenMin: 10, nowMs: now });
  assert.equal(autoDelayedPastDue.cancel, false, "cancelling would start it now");
  assert.equal(autoDelayedPastDue.delay, true);

  const playing = hostControls({ view: "playing", manual: false, startsAt: at(-1), doorsOpenMin: 10, nowMs: now });
  assert.deepEqual(playing, { startNow: false, startIn: [], delay: false, cancel: false, openDoors: false, end: true });
  assert.equal(hostControls({ view: "finished", manual: false, doorsOpenMin: 10, nowMs: now }).end, true);
  assert.equal(hostControls({ view: "live", manual: false, doorsOpenMin: 10, nowMs: now }).end, false, "the live room has End webinar");
  assert.equal(hostControls({ view: "ended", manual: false, doorsOpenMin: 10, nowMs: now }).startNow, false);
}

// ---- who is waiting, and the transition
assert.equal(
  waitingCount([
    { role: "attendee", identity: "att_ABC" },
    { role: "attendee", identity: "att_DEF" },
    { role: "host", identity: "user_1" },
    { role: "attendee", identity: "agent-captions" },
  ]),
  2,
);
assert.equal(waitingCount(undefined), 0);
assert.equal(liveWithLabel("Asha Rao"), "Live with Asha");
assert.equal(liveWithLabel(""), "Going live with the host");

console.log("simulive-host: ok");
