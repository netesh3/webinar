import assert from "node:assert/strict";
import {
  SHARE_CAPTURE_MAX,
  SHARE_MODE_FPS,
  shareCaptureResolution,
  shareCodec,
  shareContentHint,
  shareDegradation,
  shareModeOfHint,
  SHARE_KEEP_RESOLUTION,
  liveShareMode,
  noteShareMode,
  shareEncoderHint,
  shareLayout,
  shareLayoutOfEncodings,
  shareScalabilityMode,
} from "./share-mode.ts";
import {
  SHARE_1080_BITRATE,
  SHARE_720_BITRATE,
  SHARE_BITRATES,
  SHARE_FLOOR_DESKTOP,
  SHARE_FLOOR_MOBILE,
  SHARE_LADDER,
  SHARE_LAYERS,
  SHARE_TOP,
  shareCodecOfTrack,
  shareEncodingPlan,
  SHARE_SINGLE_BITRATES,
  shareLadder,
  shareLayers,
  shareNeedKbps,
  shareTop,
  summariseOutbound,
} from "./network.ts";

// Sharp is the default and holds pixels; video holds frames.
assert.equal(shareContentHint("sharp"), "detail");
assert.equal(shareDegradation("sharp"), "maintain-resolution");
assert.equal(shareContentHint("video"), "motion");
assert.equal(shareDegradation("video"), "maintain-framerate", "simulcast layout (the switch off)");
// The keep-resolution layout holds resolution in BOTH modes.
assert.equal(shareDegradation("sharp", "single"), "maintain-resolution");
assert.equal(shareDegradation("video", "single"), "maintain-resolution");

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

// Per codec. H264 keeps 1.5 / 4 Mbps in both modes; a sharp VP9 share spends 0.7 / 2.5 so
// libwebrtc can switch its 1080p layer on from ~1.8 Mbps of uplink instead of ~2.6, and
// video mode keeps H264's numbers for motion.
for (const mode of ["sharp", "video"] as const) {
  assert.equal(shareLayers(mode, "h264")[0].encoding.maxBitrate, SHARE_720_BITRATE, `h264 ${mode}: floor`);
  assert.equal(shareTop(mode, "h264").encoding.maxBitrate, SHARE_1080_BITRATE, `h264 ${mode}: top`);
  assert.equal(shareLayers(mode)[0].encoding.maxBitrate, SHARE_720_BITRATE, `${mode}: h264 is the default`);
}
assert.equal(shareLayers("sharp", "vp9")[0].encoding.maxBitrate, 700_000);
assert.equal(shareTop("sharp", "vp9").encoding.maxBitrate, 2_500_000);
assert.equal(shareTop("sharp", "vp9").height, 1080, "vp9 keeps the 1080p top");
assert.equal(shareLayers("sharp", "vp9")[0].height, SHARE_FLOOR_DESKTOP.height, "vp9 keeps the 720p floor");
assert.equal(shareLayers("video", "vp9")[0].encoding.maxBitrate, SHARE_720_BITRATE);
assert.equal(shareTop("video", "vp9").encoding.maxBitrate, SHARE_1080_BITRATE);
{
  // What has to be on the uplink before the 1080p layer is switched on: the floor's target
  // plus the top layer's ~800 kbps minimum, x1.35 screenshare hysteresis.
  const enableAt = (codec: "vp9" | "h264") => SHARE_BITRATES[codec].sharp.floor + 800_000 * 1.35;
  assert.ok(enableAt("vp9") < 2_000_000, `vp9 1080p from ${enableAt("vp9")} bps`);
  assert.ok(enableAt("h264") > 2_500_000, "h264 still needs ~2.6 Mbps");
}

// The ladder is the published codec's and mode's, and re-applying it cannot undo the above.
assert.deepEqual(
  shareLadder("vp9", "sharp").full.map((r) => r.maxBitrate),
  [700_000, 2_500_000],
);
assert.deepEqual(shareLadder("vp9", "video").full.map((r) => r.maxBitrate), [SHARE_720_BITRATE, SHARE_1080_BITRATE]);
assert.deepEqual(shareLadder("h264"), SHARE_LADDER, "the default ladder is H264's");
for (const codec of ["vp9", "h264"] as const) {
  for (const mode of ["sharp", "video"] as const) {
    const ladder = shareLadder(codec, mode);
    const floor = SHARE_BITRATES[codec][mode].floor;
    assert.equal(ladder.reduced[1].maxBitrate, 0, `${codec} ${mode}: reduced turns the top off`);
    assert.equal(ladder.minimal[0].maxFramerate, 8, `${codec} ${mode}: minimal cuts fps`);
    for (const tier of ["full", "reduced", "minimal"] as const) {
      assert.equal(ladder[tier].length, 2, `${codec} ${mode} ${tier}: one rung per encoding`);
      assert.equal(ladder[tier][0].maxBitrate, floor, `${codec} ${mode} ${tier}: the 720p floor keeps its bitrate`);
    }
  }
}
assert.ok(shareNeedKbps("full", "vp9") < shareNeedKbps("full", "h264"));

// Which ladder a live track gets: livekit-client's track.codec.
assert.equal(shareCodecOfTrack("vp9"), "vp9");
assert.equal(shareCodecOfTrack("VP9"), "vp9");
assert.equal(shareCodecOfTrack("h264"), "h264");
assert.equal(shareCodecOfTrack("vp8"), "h264");
assert.equal(shareCodecOfTrack(undefined), "h264");

// Telemetry reads every encoding: the top layer actually sent, and which are live.
{
  const s = summariseOutbound([
    { frameWidth: 1280, frameHeight: 720, framesPerSecond: 15, qualityLimitationReason: "none" },
    { frameWidth: 1920, frameHeight: 1080, framesPerSecond: 14.6, qualityLimitationReason: "none" },
  ]);
  assert.equal(s.frameHeight, 1080, "the top layer, whatever order the reports come in");
  assert.equal(s.frameWidth, 1920);
  assert.equal(s.layers, "1920x1080@15,1280x720@15");
  assert.equal(s.qualityLimitationReason, "none");
}
{
  // The 1080p layer switched off by the browser: no frames on it, and the limit says why.
  const s = summariseOutbound([
    { frameWidth: 1152, frameHeight: 720, framesPerSecond: 7, qualityLimitationReason: "bandwidth" },
    { qualityLimitationReason: "bandwidth" },
  ]);
  assert.equal(s.frameHeight, 720);
  assert.equal(s.layers, "1152x720@7");
  assert.equal(s.qualityLimitationReason, "bandwidth");
}
{
  const s = summariseOutbound([{ frameWidth: 1920, frameHeight: 1080, active: false }]);
  assert.equal(s.frameHeight, undefined, "an inactive encoding is not being sent");
  assert.equal(s.layers, "");
  assert.equal(summariseOutbound([]).qualityLimitationReason, "none");
}

// Keep resolution, drop frame rate: every share's encoding plan, per mode and browser.
assert.equal(SHARE_KEEP_RESOLUTION, true, "on by default");
assert.equal(shareLayout(), "single", "every mode");
assert.equal(shareLayout(true), "single");
assert.equal(shareLayout(false), "simulcast", "the switch puts every share back on simulcast");
assert.equal(shareLayoutOfEncodings(1), "single");
assert.equal(shareLayoutOfEncodings(2), "simulcast");
assert.equal(shareLayoutOfEncodings(undefined), "simulcast");
// The caps per mode and codec: sharp 15 fps at VP9 2.5 / H264 4 Mbps; video (a played clip, a
// file share) 30 fps at VP9 4 / H264 5 Mbps.
const SINGLE_CAPS = {
  vp9: { sharp: { bitrate: 2_500_000, fps: 15 }, video: { bitrate: 4_000_000, fps: 30 } },
  h264: { sharp: { bitrate: SHARE_1080_BITRATE, fps: 15 }, video: { bitrate: 5_000_000, fps: 30 } },
} as const;
for (const mode of ["sharp", "video"] as const) {
  // Desktop Chromium (Chrome, Edge): one VP9 SVC encoding, temporal layers only, full resolution.
  for (const ua of [UA.chromeMac, UA.edgeWin]) {
    const p = shareEncodingPlan(mode, shareCodec(ua));
    const label = `vp9 ${mode} ${ua.slice(-20)}`;
    assert.equal(p.videoCodec, "vp9", label);
    assert.equal(p.layout, "single", label);
    assert.equal(p.simulcast, false, `${label}: no simulcast, livekit publishes one SVC encoding`);
    assert.equal(p.scalabilityMode, "L1T3", `${label}: temporal layers for the SFU to drop per viewer`);
    assert.deepEqual(p.screenShareSimulcastLayers, [], `${label}: no 720p layer to fall back onto`);
    assert.equal(p.degradationPreference, "maintain-resolution", label);
    assert.equal(p.encoderHint, "motion", `${label}: detail would cap VP9 L1T3 at 5 fps, one temporal layer`);
    assert.equal(p.screenShareEncoding.maxBitrate, SINGLE_CAPS.vp9[mode].bitrate, label);
    assert.equal(p.screenShareEncoding.maxFramerate, SINGLE_CAPS.vp9[mode].fps, label);
    assert.equal(p.backupCodec, "h264", label);
  }
  // H264 browsers: one encoding at the capture's size, maintain-resolution; hint per mode.
  for (const ua of [UA.safariMac, UA.firefox, UA.chromeAndroid, UA.chromeIOS]) {
    const p = shareEncodingPlan(mode, shareCodec(ua));
    const label = `h264 ${mode} ${ua.slice(-20)}`;
    assert.equal(p.videoCodec, "h264", label);
    assert.equal(p.layout, "single", label);
    assert.equal(p.simulcast, false, label);
    assert.equal(p.scalabilityMode, undefined, label);
    assert.deepEqual(p.screenShareSimulcastLayers, [], label);
    assert.equal(p.degradationPreference, "maintain-resolution", label);
    assert.equal(p.encoderHint, mode === "sharp" ? "detail" : "motion", label);
    assert.equal(p.screenShareEncoding.maxBitrate, SINGLE_CAPS.h264[mode].bitrate, label);
    assert.equal(p.screenShareEncoding.maxFramerate, SINGLE_CAPS.h264[mode].fps, label);
    assert.equal(p.backupCodec, "vp8", label);
  }
}
for (const codec of ["vp9", "h264"] as const) {
  for (const mode of ["sharp", "video"] as const) {
    assert.equal(SHARE_SINGLE_BITRATES[codec][mode], SINGLE_CAPS[codec][mode].bitrate, `${codec} ${mode}`);
    assert.equal(shareTop(mode, codec, "single").height, 1080, `${codec} ${mode}: full resolution`);
  }
}
for (const codec of ["vp9", "h264"] as const) {
  // Only the switched-off flag goes back to what shipped before: 720p + 1080p simulcast.
  for (const [mode, keep] of [["video", false], ["sharp", false]] as const) {
    const p = shareEncodingPlan(mode, codec, keep);
    assert.equal(p.layout, "simulcast", `${codec} ${mode} keep=${keep}`);
    assert.equal(p.screenShareSimulcastLayers.length, 1, `${codec} ${mode}: the 720p layer`);
    assert.equal(p.screenShareSimulcastLayers[0].height, SHARE_FLOOR_DESKTOP.height);
    assert.equal(p.simulcast, codec === "vp9" ? true : undefined);
    assert.equal(p.scalabilityMode, codec === "vp9" ? "L1T1" : undefined);
    assert.equal(p.encoderHint, shareContentHint(mode));
    assert.equal(p.degradationPreference, shareDegradation(mode));
  }
}
assert.equal(shareScalabilityMode("h264", "single"), undefined);
assert.equal(shareEncoderHint("sharp", "h264", "single"), "detail");
assert.equal(shareEncoderHint("video", "vp9", "single"), "motion");

// The single layout's ladder, every mode: one rung, never off, never scaled — fps falls under
// pressure (sharp 15 -> 8 -> 4, video 30 -> 15 -> 8) and the bitrate follows.
const FPS_STEPS = { sharp: [15, 8, 4], video: [30, 15, 8] } as const;
for (const codec of ["vp9", "h264"] as const) {
  for (const mode of ["sharp", "video"] as const) {
    const cap = SINGLE_CAPS[codec][mode].bitrate;
    const ladder = shareLadder(codec, mode, "single");
    const label = `${codec} ${mode}`;
    for (const tier of ["full", "reduced", "minimal"] as const) {
      assert.equal(ladder[tier].length, 1, `${label} ${tier}: one encoding`);
      assert.ok(ladder[tier][0].maxBitrate > 0, `${label} ${tier}: never switched off`);
      // A rung has only bitrate and fps: there is no resolution step to take.
      for (const key of Object.keys(ladder[tier][0])) {
        assert.ok(["maxBitrate", "maxFramerate"].includes(key), `${label} ${tier}: no ${key}`);
      }
    }
    assert.deepEqual(ladder.full, [{ maxBitrate: cap }], `${label}: full is the mode's own fps`);
    assert.equal(shareTop(mode, codec, "single").encoding.maxFramerate, FPS_STEPS[mode][0], label);
    assert.equal(ladder.reduced[0].maxFramerate, FPS_STEPS[mode][1], `${label}: reduced fps`);
    assert.equal(ladder.minimal[0].maxFramerate, FPS_STEPS[mode][2], `${label}: minimal fps`);
    assert.ok(
      ladder.reduced[0].maxBitrate < cap && ladder.minimal[0].maxBitrate < ladder.reduced[0].maxBitrate,
      `${label}: bitrate falls with the fps`,
    );
  }
}
for (const mode of ["sharp", "video"] as const) {
  assert.deepEqual(shareLayers(mode, "vp9", "single"), [], `${mode}: no layer under the capture`);
  assert.deepEqual(shareLayers(mode, "h264", "single"), [], `${mode}: no layer under the capture`);
}

// The live mode: remembered per track, since VP9 L1T3 is "motion" in both modes.
{
  const a = { contentHint: "motion" };
  assert.equal(liveShareMode(a), "video", "unknown track: read off the hint");
  assert.equal(liveShareMode(a, true), "sharp", "unknown single VP9 share: a desktop share starts sharp");
  noteShareMode(a, "video");
  assert.equal(liveShareMode(a, true), "video", "a remembered mode wins");
  noteShareMode(a, "sharp");
  assert.equal(liveShareMode(a), "sharp");
  assert.equal(liveShareMode({ contentHint: "detail" }), "sharp");
  assert.equal(liveShareMode(undefined), "sharp");
}

// Telemetry: the top encoding's scalabilityMode and how many encodings there are.
{
  const s = summariseOutbound([
    { frameWidth: 1920, frameHeight: 1080, framesPerSecond: 4, qualityLimitationReason: "bandwidth", scalabilityMode: "L1T3" },
  ]);
  assert.equal(s.frameHeight, 1080, "resolution held");
  assert.equal(s.framesPerSecond, 4, "fps given up");
  assert.equal(s.qualityLimitationReason, "bandwidth");
  assert.equal(s.scalabilityMode, "L1T3");
  assert.equal(s.encodings, 1);
}

{
  // A file share is noted as video before publish (file-share.ts), so the ladder keeps its 30 fps.
  const file = { contentHint: "motion" };
  noteShareMode(file, "video");
  assert.equal(liveShareMode(file, true), "video");
}

console.log("PASS share-mode");
