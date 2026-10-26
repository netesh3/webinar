/* Tests for the load-test kit's read-out (lib/load-probe.ts). Run with `make test-web`.
 *
 * The part worth pinning is startingPath: a real viewer must always start where the join sent
 * them, and the kit's "prefer the CDN" may only swap the two URLs the join already offered. */

import assert from "node:assert/strict";
import { loadProbe, reportLoadProbe, startingPath } from "./load-probe.ts";

const BOX = "https://box.example/live/s/index.m3u8";
const CDN = "https://cdn.example/live/s/index.m3u8";

// No preference (every real viewer): the join's choice, untouched.
assert.deepEqual(startingPath(BOX, CDN, "direct", undefined), { url: BOX, fallback: CDN, path: "direct" });
assert.deepEqual(startingPath(CDN, BOX, "cdn", undefined), { url: CDN, fallback: BOX, path: "cdn" });

// The kit prefers the CDN for a viewer the join sent to the box: the two swap.
assert.deepEqual(startingPath(BOX, CDN, "direct", "cdn"), { url: CDN, fallback: BOX, path: "cdn" });
// ... and the box for one the join sent to the CDN.
assert.deepEqual(startingPath(CDN, BOX, "cdn", "direct"), { url: BOX, fallback: CDN, path: "direct" });

// Already on the preferred path, no fallback offered, or a path it doesn't know: unchanged.
assert.deepEqual(startingPath(CDN, BOX, "cdn", "cdn"), { url: CDN, fallback: BOX, path: "cdn" });
assert.deepEqual(startingPath(BOX, undefined, "direct", "cdn"), { url: BOX, fallback: undefined, path: "direct" });
assert.deepEqual(startingPath(BOX, CDN, undefined, "cdn"), { url: BOX, fallback: CDN, path: "" });

// Outside a browser, or a page the kit did not open: nothing to read, nothing written.
assert.equal(loadProbe(), null);
reportLoadProbe({ latencySec: 3 });

// Opened by the kit: the state is merged and stamped.
(globalThis as unknown as { window: unknown }).window = { __LOAD_PROBE__: { preferPath: "cdn" } };
reportLoadProbe({ latencySec: 3.2, path: "cdn" }, 1000);
reportLoadProbe({ fallbacks: 1 }, 2000);
assert.deepEqual(loadProbe()?.state, { latencySec: 3.2, path: "cdn", fallbacks: 1, at: 2000 });
assert.equal(loadProbe()?.preferPath, "cdn");

console.log("load-probe: ok");
