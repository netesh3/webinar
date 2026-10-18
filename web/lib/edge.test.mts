/* Edge delivery's pure parts: the hls.js settings, event routing, and the clock offset.
 *
 * Run: node --experimental-strip-types --no-warnings lib/edge.test.mts
 */

import assert from "node:assert/strict";
import { edgeHlsConfig, latencyLabel } from "./edge-hls.ts";
import { routeEdgeEvent } from "./edge-route.ts";
import { clockOffset, formatClock } from "./server-clock.ts";

// LL mode must leave the count settings unset so hls.js honours PART-HOLD-BACK.
const ll = edgeHlsConfig(true);
assert.equal(ll.lowLatencyMode, true);
assert.equal(ll.liveDurationInfinity, true);
assert.equal(ll.maxBufferLength, 4);
assert.equal(ll.maxLiveSyncPlaybackRate, 1.15);
assert.equal("liveSyncDurationCount" in ll, false);
assert.equal("liveMaxLatencyDurationCount" in ll, false);
assert.equal("liveSyncDuration" in ll, false);

const plain = edgeHlsConfig(false);
assert.equal(plain.lowLatencyMode, false);
assert.equal(plain.liveSyncDurationCount, 2);
assert.equal(plain.liveMaxLatencyDurationCount, 3);

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
