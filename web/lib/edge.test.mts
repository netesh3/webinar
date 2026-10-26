/* Edge delivery's pure parts: the hls.js settings, event routing, and the clock offset.
 *
 * Run: node --experimental-strip-types --no-warnings lib/edge.test.mts
 */

import assert from "node:assert/strict";
import {
  BEHIND_LIVE_SECONDS,
  CATCH_UP,
  FALLBACK_AFTER_ERRORS,
  PlaybackStats,
  STALL_WINDOW_MS,
  TARGET_SECONDS,
  bufferedAhead,
  catchUp,
  seekToTarget,
  edgeHlsConfig,
  latencyLabel,
  median,
  retryDelayMs,
  shouldUseFallback,
} from "./edge-hls.ts";
import {
  EDGE_MAX_REFRESHES,
  EDGE_RETRY_BASE_MS,
  EDGE_RETRY_MAX_MS,
  edgeRetryDelay,
  edgeStreamFailure,
  routeEdgeEvent,
} from "./edge-route.ts";
import { clockOffset, formatClock } from "./server-clock.ts";

// Plain HLS only (2026-10-25): no low-latency mode, no blocking reloads, ~6s behind live.
{
  const c = edgeHlsConfig();
  assert.equal(c.lowLatencyMode, false);
  assert.equal(c.liveDurationInfinity, true);
  assert.equal(c.liveSyncDuration, TARGET_SECONDS);
  assert.equal(TARGET_SECONDS, 6);
  // The buffer holds the whole target and more, so a slow request is absorbed.
  assert.ok(c.maxBufferLength > TARGET_SECONDS);
  // Audio is never time-stretched: no playback-rate catch-up.
  assert.equal(c.maxLiveSyncPlaybackRate, 1);
  // Not the segment-count settings: the delay is set in seconds, not 3 × TARGETDURATION.
  assert.equal("liveSyncDurationCount" in c, false);
  assert.equal("liveMaxLatencyDurationCount" in c, false);
  // Still waits out an origin that 404s while the mix boots.
  assert.ok(c.manifestLoadingMaxRetry >= 60);
}

// Keeping near live: only a jump, and only when well past the target.
{
  const at = (latency: number) => catchUp({ latency, target: TARGET_SECONDS });
  assert.equal(at(6), "stay");
  assert.equal(at(TARGET_SECONDS + CATCH_UP.jumpAbove), "stay");
  assert.equal(at(TARGET_SECONDS + CATCH_UP.jumpAbove + 0.1), "jump");
  // Nothing to go on: leave it alone.
  assert.equal(catchUp({ latency: NaN, target: TARGET_SECONDS }), "stay");
  assert.equal(catchUp({ latency: 30, target: 0 }), "stay");
  // Back to live is for someone far behind, past where the jump would already have acted.
  assert.ok(BEHIND_LIVE_SECONDS > TARGET_SECONDS + CATCH_UP.jumpAbove);
}
// A jump lands on the target, never backwards, and stays inside the buffer.
assert.equal(seekToTarget({ currentTime: 100, latency: 20, target: 6 }), 114);
assert.equal(seekToTarget({ currentTime: 100, latency: 2, target: 6 }), 100);
assert.equal(seekToTarget({ currentTime: 100, latency: 20, target: 6, bufferedEnd: 110 }), 109);
assert.equal(seekToTarget({ currentTime: 100, latency: 20, target: 6, bufferedEnd: 100.5 }), 100);
{
  const ranges = (r: [number, number][]) => ({ length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] });
  assert.equal(bufferedAhead(ranges([[0, 5], [6, 12]]), 8), 4);
  assert.equal(bufferedAhead(ranges([[0, 5]]), 5), 0);
  assert.equal(bufferedAhead(ranges([]), 1), 0);
}

// The other path, once, after several fatal network errors in a row, and only if offered.
{
  const fb = "https://zone.b-cdn.net/live/x/index.m3u8";
  assert.equal(shouldUseFallback({ fatalNetworkErrors: FALLBACK_AFTER_ERRORS - 1, fallbackUrl: fb, switched: false }), false);
  assert.equal(shouldUseFallback({ fatalNetworkErrors: FALLBACK_AFTER_ERRORS, fallbackUrl: fb, switched: false }), true);
  assert.equal(shouldUseFallback({ fatalNetworkErrors: 20, fallbackUrl: fb, switched: true }), false);
  assert.equal(shouldUseFallback({ fatalNetworkErrors: 20, fallbackUrl: undefined, switched: false }), false);
  assert.equal(shouldUseFallback({ fatalNetworkErrors: 20, fallbackUrl: "", switched: false }), false);
}

// What edge_latency reports: recent stalls and the median time to first byte.
{
  const s = new PlaybackStats();
  assert.equal(s.medianTtfb(), null);
  for (const ms of [40, 60, 50, -1, NaN]) s.fragmentLoaded(ms);
  assert.equal(s.medianTtfb(), 50);
  s.stalled(1000);
  s.stalled(2000);
  assert.equal(s.stallCount(2000), 2);
  assert.equal(s.stallCount(1000 + STALL_WINDOW_MS + 1), 1);
  // Only the most recent 50 samples: a connection that got worse shows it.
  for (let i = 0; i < 50; i++) s.fragmentLoaded(900);
  assert.equal(s.medianTtfb(), 900);
}
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([]), null);
assert.deepEqual([0, 1, 2, 3, 4, 9].map(retryDelayMs), [1000, 2000, 4000, 8000, 10_000, 10_000]);

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

// A refused event stream: 403 is the host's removal and final, 401 a token to replace, the
// rest a retry (instant-webinar-4277 looped 181 times by treating a 403 like a 401).
assert.equal(edgeStreamFailure(403), "removed");
assert.equal(edgeStreamFailure(401), "expired");
for (const status of [404, 409, 500, 502, 503, null]) assert.equal(edgeStreamFailure(status), "retry");
// Backoff: doubling from the base, capped, never tight, and jitter only ever shortens it.
assert.equal(edgeRetryDelay(1, () => 1), EDGE_RETRY_BASE_MS);
assert.equal(edgeRetryDelay(2, () => 1), EDGE_RETRY_BASE_MS * 2);
assert.equal(edgeRetryDelay(3, () => 1), EDGE_RETRY_BASE_MS * 4);
assert.equal(edgeRetryDelay(50, () => 1), EDGE_RETRY_MAX_MS);
assert.equal(edgeRetryDelay(1e9, () => 1), EDGE_RETRY_MAX_MS);
assert.equal(edgeRetryDelay(0, () => 1), EDGE_RETRY_BASE_MS);
for (let n = 1; n < 30; n++) {
  const d = edgeRetryDelay(n, () => 0);
  assert.ok(d >= EDGE_RETRY_BASE_MS * 0.75 && d <= EDGE_RETRY_MAX_MS, `attempt ${n}: ${d}`);
}
assert.ok(EDGE_MAX_REFRESHES >= 1 && EDGE_MAX_REFRESHES <= 5);

console.log("edge: ok");
