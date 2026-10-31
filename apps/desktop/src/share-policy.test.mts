/* Zoom-like share hide / extra-window close.
 *
 * Run: node --experimental-strip-types --no-warnings src/share-policy.test.mts
 */

import assert from "node:assert/strict";
import {
  closeExtraRoomDecision,
  isOwnCaptureSource,
  shareBarBounds,
  shouldHideAppWindows,
  SHARE_BAR_SIZE,
} from "./share-policy.ts";

assert.equal(shouldHideAppWindows("screen"), true);
assert.equal(shouldHideAppWindows("window"), false);

assert.deepEqual(shareBarBounds({ x: 0, y: 0, width: 1440, height: 900 }), {
  x: Math.round((1440 - SHARE_BAR_SIZE.width) / 2),
  y: 900 - SHARE_BAR_SIZE.height - 20,
  width: SHARE_BAR_SIZE.width,
  height: SHARE_BAR_SIZE.height,
});
assert.deepEqual(shareBarBounds({ x: 100, y: 50, width: 800, height: 400 }, { width: 200, height: 40 }), {
  x: 100 + Math.round((800 - 200) / 2),
  y: 50 + 400 - 40 - 20,
  width: 200,
  height: 40,
});

assert.deepEqual(closeExtraRoomDecision({ senderIsMain: true, resultsUrlOk: true }), {
  closeSender: false,
  loadResultsInMain: false,
});
assert.deepEqual(closeExtraRoomDecision({ senderIsMain: false, resultsUrlOk: true }), {
  closeSender: true,
  loadResultsInMain: true,
});
assert.deepEqual(closeExtraRoomDecision({ senderIsMain: false, resultsUrlOk: false }), {
  closeSender: true,
  loadResultsInMain: false,
});

const ours = new Set(["window:1:0"]);
assert.equal(
  isOwnCaptureSource({ id: "window:1:0", name: "Slides", kind: "window" }, ours),
  true,
);
assert.equal(
  isOwnCaptureSource({ id: "window:2:0", name: "Webinar Liv", kind: "window" }, ours),
  true,
);
assert.equal(
  isOwnCaptureSource({ id: "window:3:0", name: "Chat — Webinar Liv", kind: "window" }, ours),
  true,
);
assert.equal(
  isOwnCaptureSource({ id: "window:4:0", name: "Keynote", kind: "window" }, ours),
  false,
);
assert.equal(
  isOwnCaptureSource({ id: "screen:0:0", name: "Webinar Liv", kind: "screen" }, ours),
  false,
);

console.log("desktop-share-policy: ok");
