/* Tests for the server clock offset (lib/server-clock.ts) and that a simulive's shared
 * position is read on the corrected clock, not the device's. Run with `make test-web`. */

import assert from "node:assert/strict";
import { clockOffset, measureClock, serverNow, serverOffsetMs, setServerOffsetMs } from "./server-clock.ts";
import { sharedPositionMs } from "./simulive-replay.ts";
import { simuliveCorrection } from "./simulive-clock.ts";

// offset = serverTime + rtt/2 - clientNow (the client's receive time).
// Sent at 1000, received at 1200 (rtt 200), server stamped 6100: the stamp was taken at client
// 1100, so the server is 5000 ahead.
assert.equal(clockOffset([{ sentAt: 1000, receivedAt: 1200, serverNow: 6100 }]), 5000);
// A device clock that is ahead of the server: a negative offset.
assert.equal(clockOffset([{ sentAt: 10_000, receivedAt: 10_100, serverNow: 7050 }]), -3000);

// The shortest round trip wins: a slow sample (a wide error bar) does not drag it.
assert.equal(
  clockOffset([
    { sentAt: 0, receivedAt: 900, serverNow: 5200 }, // rtt 900: says 4750
    { sentAt: 1000, receivedAt: 1040, serverNow: 6020 }, // rtt 40: says 5000
    { sentAt: 2000, receivedAt: 2300, serverNow: 7300 }, // rtt 300: says 5150
  ]),
  5000,
);
// Nothing usable: no correction. A sample received before it was sent is nonsense.
assert.equal(clockOffset([]), 0);
assert.equal(clockOffset([{ sentAt: 100, receivedAt: 50, serverNow: 9999 }]), 0);

// measureClock: one sample per round trip, a failed one skipped.
{
  let t = 0;
  const clientNow = () => t;
  let call = 0;
  const fetchServerNow = async () => {
    call++;
    t += 50; // the request travels
    if (call === 2) throw new Error("offline");
    const stamp = t + 3000; // the server is 3s ahead
    t += 50; // the answer travels back
    return stamp;
  };
  const samples = await measureClock(fetchServerNow, 3, clientNow);
  assert.equal(samples.length, 2);
  assert.equal(clockOffset(samples), 3000);
}

// serverNow is the device clock plus the offset; the shared offset defaults to 0.
assert.equal(serverOffsetMs(), 0);
assert.equal(serverNow(1_000), 1_000);
assert.equal(serverNow(1_000, 4_000), 5_000);
setServerOffsetMs(-2_500);
assert.equal(serverNow(10_000), 7_500);
setServerOffsetMs(Number.NaN); // ignored
assert.equal(serverOffsetMs(), -2_500);
setServerOffsetMs(0);

// The simulive's shared position on the corrected clock. The session started at server time
// T; it is now T + 60s on the server. A device whose clock runs 8s fast reads T + 68s.
{
  const start = Date.parse("2026-10-24T10:00:00Z");
  const startedAt = new Date(start).toISOString();
  const deviceNow = start + 68_000;
  const offset = clockOffset([{ sentAt: deviceNow - 100, receivedAt: deviceNow + 100, serverNow: start + 60_000 }]);
  assert.equal(offset, -8_000);
  // Uncorrected it would be 8s ahead of everybody else.
  assert.equal(sharedPositionMs(startedAt, deviceNow), 68_000);
  assert.equal(sharedPositionMs(startedAt, serverNow(deviceNow, offset)), 60_000);

  // And the player is put back to the corrected position, not the device's.
  const shared = sharedPositionMs(startedAt, serverNow(deviceNow, offset))!;
  const fix = simuliveCorrection({
    positionSec: 68,
    sharedSec: shared / 1000,
    durationSec: 3600,
    paused: false,
    ended: false,
    blocked: false,
  });
  assert.equal(fix.seekTo, 60);
}

console.log("server-clock tests passed");
