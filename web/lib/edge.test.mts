/* Edge delivery's pure parts: the hls.js settings, event routing, and the clock offset.
 *
 * Run: node --experimental-strip-types --no-warnings lib/edge.test.mts
 */

import assert from "node:assert/strict";
import { ModeDecider, edgeHlsConfig, latencyLabel, median, modeLabel, retryDelayMs } from "./edge-hls.ts";
import { routeEdgeEvent } from "./edge-route.ts";
import { clockOffset, formatClock } from "./server-clock.ts";

// Neither mode may set the count settings: hls.js reads them from the constructor config and,
// when present, ignores the playlist's hold-backs — and the mode is switched at runtime.
for (const mode of ["low-latency", "standard"] as const) {
  const c = edgeHlsConfig(mode);
  assert.equal(c.lowLatencyMode, mode === "low-latency");
  assert.equal(c.liveDurationInfinity, true);
  assert.equal(c.maxLiveSyncPlaybackRate, 1.15);
  assert.equal("liveSyncDurationCount" in c, false);
  assert.equal("liveMaxLatencyDurationCount" in c, false);
  assert.equal("liveSyncDuration" in c, false);
}
assert.equal(edgeHlsConfig("low-latency").maxBufferLength, 4);
assert.equal(edgeHlsConfig("standard").maxBufferLength, 6);

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
  assert.equal(d.stalled(1000), null);
  assert.equal(d.stalled(5000), null);
  assert.equal(d.stalled(9000), "standard");
  assert.equal(d.mode, "standard");
  for (let i = 0; i < 10; i++) assert.equal(d.fragmentLoaded(20, 20_000 + i * 100), null);
  assert.equal(d.mode, "standard");
}
// Stalls spread out over minutes are not "repeated".
{
  const d = new ModeDecider({ cdn: true, now: 0 });
  assert.equal(d.stalled(0), null);
  assert.equal(d.stalled(40_000), null);
  assert.equal(d.stalled(80_000), null);
  assert.equal(d.mode, "low-latency");
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
