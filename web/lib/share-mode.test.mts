import assert from "node:assert/strict";
import {
  SHARE_CAPTURE_MAX,
  SHARE_MODE_FPS,
  shareCaptureResolution,
  shareCodec,
  shareContentHint,
  shareDegradation,
  shareModeOfHint,
} from "./share-mode.ts";
import {
  SHARE_1080_BITRATE,
  SHARE_FLOOR_DESKTOP,
  SHARE_FLOOR_MOBILE,
  SHARE_LADDER,
  SHARE_LAYERS,
  SHARE_TOP,
  shareLayers,
  shareTop,
} from "./network.ts";

// Sharp is the default and holds pixels; video holds frames.
assert.equal(shareContentHint("sharp"), "detail");
assert.equal(shareDegradation("sharp"), "maintain-resolution");
assert.equal(shareContentHint("video"), "motion");
assert.equal(shareDegradation("video"), "maintain-framerate");

// VP9 on desktop Chromium (Chrome, Edge, Brave, Opera all say Chrome/); H264 elsewhere.
const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  chromeIOS: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1",
};
assert.equal(shareCodec(UA.chromeMac), "vp9");
assert.equal(shareCodec(UA.edgeWin), "vp9");
for (const ua of [UA.safariMac, UA.firefox, UA.chromeAndroid, UA.chromeIOS, ""]) {
  assert.equal(shareCodec(ua), "h264", ua);
}

// A live share's mode is read back off its track; anything but motion is sharp.
assert.equal(shareModeOfHint("motion"), "video");
assert.equal(shareModeOfHint("detail"), "sharp");
assert.equal(shareModeOfHint(""), "sharp");
assert.equal(shareModeOfHint(undefined), "sharp");

// Capture: desktop up to 1080p, always at 30 fps (the mode can switch mid-share; sharp's
// 15 fps is the encoder's cap); Safari unconstrained; phones at the floor.
const desktop = { safari: false, mobile: false, mobileFloor: SHARE_FLOOR_MOBILE };
assert.deepEqual(shareCaptureResolution(desktop), { width: 1920, height: 1080, frameRate: 30 });
assert.equal(shareCaptureResolution({ ...desktop, safari: true }), undefined);
assert.deepEqual(shareCaptureResolution({ ...desktop, mobile: true }), {
  width: SHARE_FLOOR_MOBILE.width,
  height: SHARE_FLOOR_MOBILE.height,
  frameRate: 30,
});
assert.equal(SHARE_CAPTURE_MAX.height, SHARE_TOP.height, "capture ceiling is the 1080p top layer");

// Layers: the 720p desktop floor, then the top (the 1080p capture). No layer below 720p.
for (const mode of ["sharp", "video"] as const) {
  const layers = shareLayers(mode);
  assert.equal(layers.length, 1, `${mode}: one layer below the top (two encodings)`);
  assert.equal(layers[0].height, SHARE_FLOOR_DESKTOP.height, `${mode}: the low layer is the 720p floor`);
  assert.equal(layers[0].encoding.maxFramerate, SHARE_MODE_FPS[mode], `${mode}: 720p at the mode's fps`);
  assert.equal(shareTop(mode).encoding.maxFramerate, SHARE_MODE_FPS[mode], `${mode}: top at the mode's fps`);
  assert.equal(shareTop(mode).height, 1080, `${mode}: top is 1080p`);
}
assert.equal(SHARE_MODE_FPS.sharp, 15);
assert.equal(SHARE_MODE_FPS.video, 30);
// The publish defaults are the sharp mode.
assert.equal(SHARE_TOP.encoding.maxFramerate, SHARE_MODE_FPS.sharp);
assert.equal(SHARE_LAYERS[0].encoding.maxFramerate, SHARE_MODE_FPS.sharp);
assert.equal(SHARE_TOP.encoding.maxBitrate, SHARE_1080_BITRATE);

// The 1080p top layer is live only in the full tier; the 720p floor never drops.
assert.ok(SHARE_LADDER.full[1].maxBitrate > 0, "full tier keeps the top layer");
assert.equal(SHARE_LADDER.reduced[1].maxBitrate, 0, "reduced turns the top layer off first");
assert.equal(SHARE_LADDER.minimal[1].maxBitrate, 0, "minimal keeps it off");
for (const tier of ["full", "reduced", "minimal"] as const) {
  assert.ok(SHARE_LADDER[tier][0].maxBitrate > 0, `${tier}: the 720p floor stays live`);
}

console.log("PASS share-mode");
