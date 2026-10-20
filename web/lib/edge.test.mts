/* Edge delivery's pure parts: the hls.js settings, event routing, and the clock offset.
 *
 * Run: node --experimental-strip-types --no-warnings lib/edge.test.mts
 */

import assert from "node:assert/strict";
import {
  CATCH_UP,
  ModeDecider,
  LL_RETRIES,
  LL_RETRY_AFTER_MS,
  bufferedAhead,
  catchUp,
  liveTarget,
  seekToTarget,
  STANDARD_TARGET_SECONDS,
  edgeHlsConfig,
  latencyLabel,
  median,
  modeLabel,
  retryDelayMs,
} from "./edge-hls.ts";
import { routeEdgeEvent } from "./edge-route.ts";
import { clockOffset, formatClock } from "./server-clock.ts";

// Neither mode may set the count settings: hls.js reads them from the constructor config and,
// when present, ignores the playlist's hold-backs — and the mode is switched at runtime.
for (const mode of ["low-latency", "standard"] as const) {
  const c = edgeHlsConfig(mode);
  assert.equal(c.lowLatencyMode, mode === "low-latency");
  assert.equal(c.liveDurationInfinity, true);
  // Audio is never time-stretched: no playback-rate catch-up, in either mode.
  assert.equal(c.maxLiveSyncPlaybackRate, 1);
  assert.equal(c.liveSyncOnStallIncrease, 0.25);
  assert.equal("liveSyncDurationCount" in c, false);
  assert.equal("liveMaxLatencyDurationCount" in c, false);
  assert.equal("liveSyncDuration" in c, false);
}
assert.equal(edgeHlsConfig("low-latency").maxBufferLength, 4);
assert.equal(edgeHlsConfig("standard").maxBufferLength, 6);

// Standard mode catches up, since hls.js only does in low-latency mode.
{
  const at = (latency: number, rate = 1, bufferAhead = 4) => catchUp({ latency, target: 3, bufferAhead, rate });
  // Near the target: normal speed.
  assert.deepEqual(at(3.5), { rate: 1 });
  // A little behind: faster, until close to the target again (hysteresis).
  assert.deepEqual(at(4.5), { rate: CATCH_UP.rate });
  assert.deepEqual(at(3.6, CATCH_UP.rate), { rate: CATCH_UP.rate });
  assert.deepEqual(at(3.2, CATCH_UP.rate), { rate: 1 });
  // Never at the cost of the buffer: that would cause the stall it recovers from.
  assert.deepEqual(at(4.5, CATCH_UP.rate, 1), { rate: 1 });
  // More than 2s behind the target (the edge test's 5–6s): jump, buffer or not.
  assert.equal(at(5.5), "jump");
  assert.equal(at(9.5, 1, 0), "jump");
  // Nothing to go on: leave it alone.
  assert.deepEqual(catchUp({ latency: NaN, target: 3, bufferAhead: 4, rate: 1.1 }), { rate: 1 });
  assert.deepEqual(catchUp({ latency: 7, target: 0, bufferAhead: 4, rate: 1 }), { rate: 1 });
}
// Standard mode aims for its own target, not hls.js's 3 × TARGETDURATION (6s+ on MediaMTX).
assert.equal(liveTarget("standard", 6), STANDARD_TARGET_SECONDS);
assert.equal(liveTarget("standard", null), STANDARD_TARGET_SECONDS);
assert.equal(liveTarget("low-latency", 1.2), 1.2);
assert.equal(liveTarget("low-latency", null), null);
// Sitting at hls.js's 6s counts as behind, so it catches up.
assert.deepEqual(catchUp({ latency: 6, target: liveTarget("standard", 6)!, bufferAhead: 4, rate: 1 }), { rate: CATCH_UP.rate });
// A jump lands on the target, not on hls.js's liveSyncPosition; never backwards.
assert.equal(seekToTarget({ currentTime: 100, latency: 10, target: 3 }), 107);
assert.equal(seekToTarget({ currentTime: 100, latency: 2, target: 3 }), 100);
// An automatic jump stays inside the buffer: the edge test's start sat on black after jumping
// from 0 (latency read as the whole window) to 7.96 with only 1.1–4.1 buffered.
assert.ok(Math.abs(seekToTarget({ currentTime: 0, latency: 10, target: 4, bufferedEnd: 4.1 }) - 3.1) < 1e-9);
assert.equal(seekToTarget({ currentTime: 100, latency: 12, target: 4, bufferedEnd: 110 }), 108);
assert.equal(seekToTarget({ currentTime: 100, latency: 12, target: 4, bufferedEnd: 100.5 }), 100);
{
  const ranges = (r: [number, number][]) => ({ length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] });
  assert.equal(bufferedAhead(ranges([[0, 5], [6, 12]]), 8), 4);
  assert.equal(bufferedAhead(ranges([[0, 5]]), 5), 0);
  assert.equal(bufferedAhead(ranges([]), 1), 0);
}

// Far from the origin (India → Germany, ~450ms per request): stays smooth.
{
  const d = new ModeDecider({ cdn: false, now: 0 });
  assert.equal(d.mode, "standard");
  for (let i = 0; i < 10; i++) assert.equal(d.fragmentLoaded(450, i * 1000), null);
  assert.equal(d.mode, "standard");
}
// Close to it (a CDN edge): moves up to low latency once it has enough samples.
{
  const d = new ModeDecider({ cdn: false, now: 0 });
  const changes = [40, 60, 55, 70, 45, 50].map((ms, i) => d.fragmentLoaded(ms, i * 500));
  assert.deepEqual(changes, [null, null, null, null, null, "low-latency"]);
  assert.equal(d.mode, "low-latency");
  assert.equal(Math.round(d.medianTtfb() ?? 0), 53);
}
// The decision is taken once: later fast samples do not flip a slow start.
{
  const d = new ModeDecider({ cdn: false, now: 0 });
  for (let i = 0; i < 6; i++) d.fragmentLoaded(400, i * 1000);
  for (let i = 0; i < 20; i++) assert.equal(d.fragmentLoaded(30, 10_000 + i * 100), null);
  assert.equal(d.mode, "standard");
}
// A CDN start is low latency at once, and repeated stalls drop it back for good.
{
  const d = new ModeDecider({ cdn: true, now: 0 });
  assert.equal(d.mode, "low-latency");
  d.played(0);
  assert.equal(d.stalled(16_000), null);
  assert.equal(d.stalled(20_000), null);
  assert.equal(d.stalled(24_000), "standard");
  assert.equal(d.mode, "standard");
  for (let i = 0; i < 10; i++) assert.equal(d.fragmentLoaded(20, 20_000 + i * 100), null);
  assert.equal(d.mode, "standard");
}
// Stalls while the player is starting up do not count.
{
  const d = new ModeDecider({ cdn: true, now: 0 });
  d.played(0);
  for (const t of [1000, 3000, 5000, 7000, 14_000]) assert.equal(d.stalled(t), null);
  assert.equal(d.mode, "low-latency");
  assert.equal(d.stallCount(14_000), 0);
}
// The grace runs from the first frame: a viewer who waited a minute for the mix to start
// still gets it, and nothing before the first frame counts.
{
  const d = new ModeDecider({ cdn: true, now: 0 });
  assert.equal(d.stalled(30_000), null); // no frame yet
  d.played(60_000);
  for (const t of [61_000, 64_000, 68_000, 74_000]) assert.equal(d.stalled(t), null);
  assert.equal(d.mode, "low-latency");
  assert.equal(d.stalled(80_000), null);
  assert.equal(d.stalled(84_000), null);
  assert.equal(d.stalled(88_000), "standard");
}
// Stalls spread out over minutes are not "repeated".
{
  const d = new ModeDecider({ cdn: true, now: 0 });
  d.played(0);
  assert.equal(d.stalled(0), null);
  assert.equal(d.stalled(40_000), null);
  assert.equal(d.stalled(80_000), null);
  assert.equal(d.mode, "low-latency");
}

// A drop to standard is not for good: after LL_RETRY_AFTER_MS of standard with no stall it
// tries low latency again, at most LL_RETRIES times; a stall in standard restarts the wait.
{
  const d = new ModeDecider({ cdn: true, now: 0 });
  d.played(0);
  for (const t of [20_000, 21_000, 22_000]) d.stalled(t);
  assert.equal(d.mode, "standard");
  assert.equal(d.tick(22_000 + LL_RETRY_AFTER_MS - 1), null);
  d.stalled(60_000); // a stall in standard: wait again from here
  assert.equal(d.tick(22_000 + LL_RETRY_AFTER_MS), null);
  assert.equal(d.tick(60_000 + LL_RETRY_AFTER_MS), "low-latency");
  assert.equal(d.mode, "low-latency");
  let at = 60_000 + LL_RETRY_AFTER_MS;
  for (let round = 1; round < LL_RETRIES; round++) {
    for (const t of [at + 1000, at + 2000, at + 3000]) d.stalled(t);
    at += 3000;
    assert.equal(d.mode, "standard");
    assert.equal(d.tick(at + LL_RETRY_AFTER_MS), "low-latency");
    at += LL_RETRY_AFTER_MS;
  }
  // Retries used up: the last drop stays.
  for (const t of [at + 1000, at + 2000, at + 3000]) d.stalled(t);
  assert.equal(d.mode, "standard");
  assert.equal(d.tick(at + 10 * LL_RETRY_AFTER_MS), null);
}
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([]), null);
assert.deepEqual([0, 1, 2, 3, 4, 9].map(retryDelayMs), [1000, 2000, 4000, 8000, 10_000, 10_000]);
assert.equal(modeLabel("standard"), "Smooth");

assert.equal(latencyLabel(2.345), "2.3s");
assert.equal(latencyLabel(12.6), "13s");
assert.equal(latencyLabel(null), "—");
assert.equal(latencyLabel(-1), "—");

// Routing.
assert.deepEqual(routeEdgeEvent("meta", '{"status":"live"}', "att_a"), { type: "meta", data: '{"status":"live"}' });
assert.deepEqual(routeEdgeEvent("packet", '{"kind":"chat","text":"hi"}', "att_a"), {
  type: "packet",
  data: '{"kind":"chat","text":"hi"}',
});
assert.deepEqual(routeEdgeEvent("packet", '{"kind":"stage-granted","identity":"att_a"}', "att_a"), { type: "promoted" });
assert.deepEqual(routeEdgeEvent("packet", '{"kind":"stage-granted","identity":"att_b"}', "att_a"), { type: "ignore" });
assert.deepEqual(routeEdgeEvent("packet", '{"kind":"stage-revoked","identity":"att_a"}', "att_a"), { type: "demoted" });
assert.deepEqual(routeEdgeEvent("packet", '{"kind":"removed","identity":"att_a"}', "att_a"), { type: "removed" });
// A stage invite is an ordinary packet: the shared realtime hook shows the card.
assert.equal(routeEdgeEvent("packet", '{"kind":"stage-invite","identity":"att_a"}', "att_a").type, "packet");
assert.deepEqual(routeEdgeEvent("refetch", '{"kind":"chat"}', "att_a"), { type: "refetch", kind: "chat" });
assert.deepEqual(routeEdgeEvent("reconnect", "{}", "att_a"), { type: "reconnect" });
assert.deepEqual(routeEdgeEvent("packet", "not json", "att_a"), { type: "ignore" });
assert.deepEqual(routeEdgeEvent("other", "{}", "att_a"), { type: "ignore" });

// Clock: the shortest round trip wins; the server stamped it halfway.
assert.equal(
  clockOffset([
    { sentAt: 1000, receivedAt: 1400, serverNow: 5000 }, // rtt 400
    { sentAt: 2000, receivedAt: 2100, serverNow: 6050 }, // rtt 100 -> offset 6050 - 2050 = 4000
  ]),
  4000,
);
assert.equal(clockOffset([]), 0);
assert.equal(formatClock(Date.UTC(2026, 9, 18, 7, 5, 9, 42)), "07:05:09.042");

console.log("edge: ok");
