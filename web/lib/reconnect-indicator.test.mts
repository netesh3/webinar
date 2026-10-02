/* The "Reconnecting…" indicator waits out blips. Auto-reconnect is not under test
 * here — only whether the label would be on screen.
 *
 * Run with `make test-web`.
 */

import {
  RECONNECT_INDICATOR_DELAY_MS,
  ReconnectIndicator,
  linkForRoom,
  roomPresenceDown,
} from "./reconnect-indicator.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL  ${what}${detail ? `\n      ${detail}` : ""}`);
}

ok(RECONNECT_INDICATOR_DELAY_MS === 6_000, "delay is 6 seconds");

// ---- which signal actually means "out of the room"
{
  ok(linkForRoom("signalReconnecting") === "connected", "signal resume keeps the link up");
  ok(!roomPresenceDown("signalReconnecting", null), "signal resume is not a drop");
  ok(!roomPresenceDown("connected", null), "connected is up");
  ok(!roomPresenceDown("connecting", null), "first connect is the joining banner, not this indicator");
  ok(roomPresenceDown("reconnecting", null), "full restart is down");
  ok(roomPresenceDown("disconnected", null), "SDK give-up is down");
  ok(roomPresenceDown("connecting", 1), "the retry ladder is down even between attempts");
  ok(roomPresenceDown("connected", 2), "a ladder still in flight outranks a connected sample");
}

// ---- a blip shorter than the delay is never shown
{
  const d = new ReconnectIndicator();
  const t0 = 10_000;
  ok(d.update(true, t0) === false, "hidden the instant the link drops");
  ok(d.showAt(t0) === t0 + RECONNECT_INDICATOR_DELAY_MS, "show is scheduled one delay out");
  ok(d.update(true, t0 + RECONNECT_INDICATOR_DELAY_MS - 1) === false, "hidden just under 6s");
  ok(d.update(false, t0 + RECONNECT_INDICATOR_DELAY_MS - 1) === false, "recovery before 6s never showed it");
  ok(d.showAt(t0 + RECONNECT_INDICATOR_DELAY_MS) === null, "the pending show is cancelled");
}

// ---- continuously down for the delay: shown
{
  const d = new ReconnectIndicator();
  const t0 = 1_000;
  d.update(true, t0);
  ok(d.update(true, t0 + RECONNECT_INDICATOR_DELAY_MS) === true, "shown at exactly 6s");
  ok(d.showAt(t0 + RECONNECT_INDICATOR_DELAY_MS) === null, "nothing further to schedule once shown");
  ok(d.update(true, t0 + RECONNECT_INDICATOR_DELAY_MS + 2_000) === true, "stays shown while still down");
}

// ---- recovery hides it at once, and the clock does not carry into the next drop
{
  const d = new ReconnectIndicator();
  d.update(true, 0);
  ok(d.update(true, RECONNECT_INDICATOR_DELAY_MS) === true, "visible after a real drop");
  ok(d.update(false, RECONNECT_INDICATOR_DELAY_MS + 50) === false, "hidden on the recovery sample");
  ok(d.showAt(RECONNECT_INDICATOR_DELAY_MS + 50) === null, "no timer left after recovery");
}

// ---- flapping does not accumulate across recoveries
{
  const d = new ReconnectIndicator();
  ok(d.update(true, 0) === false, "first flap starts hidden");
  ok(d.update(true, 4_000) === false, "4s is not enough");
  ok(d.update(false, 4_100) === false, "recovery clears that 4s");
  ok(d.update(true, 5_000) === false, "the next drop starts its own clock");
  ok(d.update(true, 5_000 + 4_000) === false, "another 4s does not add to the previous 4s");
  ok(d.showAt(9_000) === 5_000 + RECONNECT_INDICATOR_DELAY_MS, "deadline is measured from the latest drop");
  ok(d.update(false, 9_100) === false, "second recovery cancels again");
  ok(d.update(true, 20_000) === false, "third drop starts clean");
  ok(d.update(true, 20_000 + RECONNECT_INDICATOR_DELAY_MS - 1) === false, "still hidden under a fresh 6s");
  ok(d.update(true, 20_000 + RECONNECT_INDICATOR_DELAY_MS) === true, "shown only after one continuous 6s");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
