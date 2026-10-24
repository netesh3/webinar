/* The mix's camera subscriptions (lib/mix-subscriptions.ts) — run with `make test-web`.
 *
 * Every camera the egress is sent, it decodes in software on the box that also encodes the
 * mix. These pin the tile-to-layer mapping, that undrawn cameras are not forwarded, and that
 * the share never goes through the camera mapping, over the real layouts at 1280x720. */

import assert from "node:assert/strict";
import { placeStage, SHARE_ID } from "./composite-layouts.ts";
import {
  cameraLayerForTile,
  cameraSubscriptions,
  HIDDEN_CAMERA_GRACE_MS,
  LOW_TILE_MAX_PX,
  MEDIUM_TILE_MAX_PX,
  type CameraSubscription,
} from "./mix-subscriptions.ts";

let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks++;
};

// The thresholds themselves: high only above 540, low below 300.
check(() => {
  assert.equal(LOW_TILE_MAX_PX, 300);
  assert.equal(MEDIUM_TILE_MAX_PX, 540);
  assert.ok(HIDDEN_CAMERA_GRACE_MS > 0 && HIDDEN_CAMERA_GRACE_MS <= 5000);
});

check(() => {
  const at = (heightPx: number, pixelRatio?: number) => cameraLayerForTile({ heightPx, pixelRatio });
  assert.equal(at(100), "low");
  assert.equal(at(299), "low");
  assert.equal(at(300), "medium");
  assert.equal(at(360), "medium");
  assert.equal(at(540), "medium");
  assert.equal(at(541), "high");
  assert.equal(at(720), "high");
  // Output pixels: a 300 CSS px tile at ratio 2 covers 600 encoded rows.
  assert.equal(at(300, 2), "high");
  assert.equal(at(200, 2), "medium");
  // Nonsense sizes take the cheapest layer, a missing or bad ratio counts as 1.
  assert.equal(at(Number.NaN), "low");
  assert.equal(at(-10), "low");
  assert.equal(at(400, 0), "medium");
  assert.equal(at(400, Number.NaN), "medium");
});

// Speaker view's bare tile is the middle layer whatever its size: phones cut their PiP out of it.
check(() => {
  assert.equal(cameraLayerForTile({ heightPx: 120, bare: true }), "medium");
  assert.equal(cameraLayerForTile({ heightPx: 700, bare: true }), "medium");
});

const FRAME = { w: 1280, h: 720 };
const cams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, cameraOn: true }));
const plan = (layout: string, n: number, share: boolean) => {
  const result = placeStage(layout, { frame: FRAME, share, cameras: cams(n), edge: true });
  return cameraSubscriptions(cams(n).map((c) => c.id), result.placements);
};
const tally = (p: Map<string, CameraSubscription>) => {
  const out: Record<string, number> = {};
  for (const s of p.values()) {
    const k = s.enabled ? s.layer : "off";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

// One camera filling the frame keeps the top layer: it is the whole picture.
check(() => assert.deepEqual(tally(plan("grid", 1, false)), { high: 1 }));

// Two to four cameras in a 720p grid are 360p tiles: the medium layer, not four 1080p decodes.
check(() => {
  assert.deepEqual(tally(plan("grid", 2, false)), { medium: 2 });
  assert.deepEqual(tally(plan("grid", 4, false)), { medium: 4 });
});

// Auto: one main speaker on the top layer, the strip on the low one, past the strip nothing.
check(() => {
  assert.deepEqual(tally(plan("auto", 4, false)), { high: 1, low: 3 });
  const many = tally(plan("auto", 20, false));
  assert.equal(many.high, 1);
  assert.ok((many.off ?? 0) > 0, "cameras past the strip are not forwarded");
});

// The edge default while sharing (speaker view): one camera drawn, the others not forwarded.
// This is the 3-4 cameras + share case, where every hidden camera used to be a 1080p decode.
check(() => {
  assert.deepEqual(tally(plan("auto", 4, true)), { medium: 1, off: 3 });
  assert.deepEqual(tally(plan("speaker_view", 4, true)), { medium: 1, off: 3 });
});

// Share only: no camera is drawn, so none is forwarded.
check(() => assert.deepEqual(tally(plan("share_only", 3, true)), { off: 3 }));

// The share's placement never becomes a camera subscription, however big it is.
check(() => {
  const p = cameraSubscriptions(["c0"], [
    { id: SHARE_ID, rect: { x: 0, y: 0, w: 1280, h: 720 } },
    { id: "c0", rect: { x: 0, y: 0, w: 320, h: 180 } },
  ]);
  assert.equal(p.size, 1);
  assert.equal(p.has(SHARE_ID), false);
  assert.deepEqual(p.get("c0"), { enabled: true, layer: "low" });
});

// No layout at 1280x720 asks for the top layer for more than one camera.
check(() => {
  for (const layout of ["auto", "grid", "speaker", "speaker_view", "share_speaker", "side_by_side", "video_only", "share_only"]) {
    for (const share of [false, true]) {
      for (const n of [1, 2, 3, 4, 9, 20]) {
        const high = tally(plan(layout, n, share)).high ?? 0;
        assert.ok(high <= 1, `${layout} share=${share} n=${n}: ${high} cameras on the top layer`);
      }
    }
  }
});

console.log(`mix-subscriptions: ${checks} checks passed`);
