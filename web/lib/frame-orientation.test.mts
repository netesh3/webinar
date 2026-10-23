/* Which browsers copy background-processor frames through a 2D canvas (iPhone Safari's
 * upside-down presenter; see lib/frame-orientation.ts).
 *
 * Run: node --experimental-strip-types --no-warnings lib/frame-orientation.test.mts
 */

import assert from "node:assert/strict";
import {
  PHONE_LONG_SIDE,
  capLongSide,
  isAppleMobile,
  isWebKitEngine,
  needsUprightCopy,
  processingLongSide,
  uprightSize,
} from "./frame-orientation.ts";

const safariIOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
// The iPhone in the 2026-10-23 report: iOS 26 Safari, OS frozen at 18_7 in the UA.
const safariIOS26 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const safariIOS17 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const chromeIOS26 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.8059.37 Mobile/15E148 Safari/604.1";
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

// The copy is for WebKit, every version: iOS 17, 18, and 26 (whose UA freezes the OS at 18_7
// and puts the real version in Version/26.x), Safari, Chrome and Firefox on iOS, iPad, Mac.
for (const ua of [safariIOS, safariIOS26, safariIOS17, chromeIOS, chromeIOS26, firefoxIOS, safariIPad, safariMac]) {
  assert.equal(needsUprightCopy({ ua }), true, ua);
}
// Chrome/Edge (modern path) and Firefox (fallback, not WebKit) are untouched.
for (const ua of [chromeMac, edgeWin, chromeAndroid, firefoxMac, ""]) {
  assert.equal(needsUprightCopy({ ua }), false, ua);
}

// Apple phones and tablets, iPadOS's desktop-looking UA by its touch points.
assert.equal(isAppleMobile(safariIOS26), true);
assert.equal(isAppleMobile(chromeIOS), true);
assert.equal(isAppleMobile(safariIPad), true);
assert.equal(isAppleMobile(safariMac, 5), true); // iPadOS Safari "Request Desktop Website"
assert.equal(isAppleMobile(safariMac, 0), false);
assert.equal(isAppleMobile(chromeMac, 5), false); // a touchscreen Mac-UA Chrome is not an iPad
assert.equal(isAppleMobile(chromeAndroid, 5), false);

// Lighter background on an Apple phone on the canvas fallback, where the result is scaled
// back to the camera's size; full size where the engine's canvas is the published frame.
// The full gate matrix: [ua, touch, hasTrackProcessor] -> long side.
const matrix: [string, number, boolean, number | null][] = [
  [safariIOS, 5, false, PHONE_LONG_SIDE],
  [safariIOS26, 5, false, PHONE_LONG_SIDE],
  [safariIOS17, 5, false, PHONE_LONG_SIDE],
  [chromeIOS26, 5, false, PHONE_LONG_SIDE],
  [safariIPad, 5, false, PHONE_LONG_SIDE],
  [safariMac, 5, false, PHONE_LONG_SIDE],
  [safariIOS26, 5, true, null],
  [safariMac, 0, false, null],
  [chromeMac, 0, true, null],
  [chromeAndroid, 5, true, null],
  [firefoxMac, 0, false, null],
];
for (const [ua, maxTouchPoints, hasTrackProcessor, want] of matrix) {
  assert.equal(processingLongSide({ ua, maxTouchPoints, hasTrackProcessor }), want, `${ua} ${hasTrackProcessor}`);
}

// Upright size: WebCodecs rotation swaps a quarter turn, not a half.
const buffer = { displayWidth: 1280, displayHeight: 720 };
assert.deepEqual(uprightSize({ ...buffer, rotation: 0 }), { w: 1280, h: 720 });
assert.deepEqual(uprightSize({ ...buffer, rotation: 90 }), { w: 720, h: 1280 });
assert.deepEqual(uprightSize({ ...buffer, rotation: 180 }), { w: 1280, h: 720 });
assert.deepEqual(uprightSize({ ...buffer, rotation: 270 }), { w: 720, h: 1280 });
assert.deepEqual(uprightSize({ ...buffer, rotation: -90 }), { w: 720, h: 1280 });
// Without rotation, the <video> showing the camera settles it.
assert.deepEqual(uprightSize(buffer, { width: 720, height: 1280 }), { w: 720, h: 1280 });
assert.deepEqual(uprightSize(buffer, { width: 1280, height: 720 }), { w: 1280, h: 720 });
assert.deepEqual(uprightSize({ displayWidth: 720, displayHeight: 1280 }, { width: 720, height: 1280 }), {
  w: 720,
  h: 1280,
});
// The phone turned to landscape: the frame already says so, and the element agrees.
assert.deepEqual(uprightSize({ displayWidth: 1280, displayHeight: 720 }, { width: 1280, height: 720 }), {
  w: 1280,
  h: 720,
});
// Rotation already applied by the browser (dims already portrait) plus the element: unchanged.
assert.deepEqual(uprightSize({ displayWidth: 720, displayHeight: 1280, rotation: 0 }, { width: 720, height: 1280 }), {
  w: 720,
  h: 1280,
});
// Nothing to go on: the frame's own numbers.
assert.deepEqual(uprightSize(buffer, null), { w: 1280, h: 720 });
assert.deepEqual(uprightSize(buffer, { width: 0, height: 0 }), { w: 1280, h: 720 });
assert.deepEqual(uprightSize({ displayWidth: 640, displayHeight: 640 }, { width: 720, height: 1280 }), {
  w: 640,
  h: 640,
});

// Capping: never grows, keeps the aspect, even pixels.
assert.deepEqual(capLongSide({ w: 720, h: 1280 }, 640), { w: 360, h: 640 });
assert.deepEqual(capLongSide({ w: 1920, h: 1080 }, 640), { w: 640, h: 360 });
assert.deepEqual(capLongSide({ w: 480, h: 640 }, 640), { w: 480, h: 640 });
assert.deepEqual(capLongSide({ w: 480, h: 360 }, 640), { w: 480, h: 360 });
assert.deepEqual(capLongSide({ w: 720, h: 1280 }, null), { w: 720, h: 1280 });
assert.deepEqual(capLongSide({ w: 1080, h: 1440 }, 640), { w: 480, h: 640 });

console.log("frame-orientation: ok");
