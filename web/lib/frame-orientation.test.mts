/* Which browsers copy background-processor frames through a 2D canvas (iPhone Safari's
 * upside-down presenter; see lib/frame-orientation.ts).
 *
 * Run: node --experimental-strip-types --no-warnings lib/frame-orientation.test.mts
 */

import assert from "node:assert/strict";
import { isWebKitEngine, needsUprightCopy } from "./frame-orientation.ts";

const safariIOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const chromeIOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1";
const firefoxIOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15";
const safariIPad =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const safariMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const chromeMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const edgeWin =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const chromeAndroid =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const firefoxMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0";

// WebKit: Safari everywhere, and every iOS browser whatever its name.
for (const ua of [safariIOS, chromeIOS, firefoxIOS, safariIPad, safariMac]) {
  assert.equal(isWebKitEngine(ua), true, ua);
}
for (const ua of [chromeMac, edgeWin, chromeAndroid, firefoxMac, ""]) {
  assert.equal(isWebKitEngine(ua), false, ua);
}

// The copy is for WebKit on the canvas fallback only.
assert.equal(needsUprightCopy({ ua: safariIOS, hasTrackProcessor: false }), true);
assert.equal(needsUprightCopy({ ua: chromeIOS, hasTrackProcessor: false }), true);
assert.equal(needsUprightCopy({ ua: safariMac, hasTrackProcessor: false }), true);
// A WebKit that grows MediaStreamTrackProcessor leaves the fallback, and the copy with it.
assert.equal(needsUprightCopy({ ua: safariIOS, hasTrackProcessor: true }), false);
// Chrome/Edge (modern path) and Firefox (fallback, not WebKit) are untouched.
assert.equal(needsUprightCopy({ ua: chromeMac, hasTrackProcessor: true }), false);
assert.equal(needsUprightCopy({ ua: edgeWin, hasTrackProcessor: true }), false);
assert.equal(needsUprightCopy({ ua: chromeAndroid, hasTrackProcessor: true }), false);
assert.equal(needsUprightCopy({ ua: firefoxMac, hasTrackProcessor: false }), false);

console.log("frame-orientation: ok");
