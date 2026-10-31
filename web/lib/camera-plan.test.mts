/* Which camera each device publishes, and that a phone's voice comes first (31 Oct 2026).
 *
 * Run with `node --experimental-strip-types --no-warnings lib/camera-plan.test.mts`.
 *
 * meeting-1865: two iPhones (our iOS app's WKWebView, Mobile Safari) published 1920×1080 cameras
 * at a desktop's 3.24 Mbps, and their audio went robotic. cameraPlanFor is the one place that
 * decides a device's capture, layers, priority and ladder, so every device class is played
 * through it here, by real user agent.
 */

import assert from "node:assert/strict";
import { governorStep, initialGovernor, type Clear, type GovernorConfig, type Signals } from "./adapt-governor.ts";
import {
  ADAPT,
  CAMERA_720,
  CAMERA_LAYERS,
  CAMERA_TOP,
  LADDER,
  PHONE_CAMERA_LAYERS,
  PHONE_CAMERA_TOP,
  PHONE_LADDER,
  SPEECH_AUDIO,
  cameraCaptureOptions,
  cameraEncodingPlan,
  cameraPlanFor,
  type CameraDevice,
  type CameraPlan,
} from "./network.ts";

let checks = 0;
function check(fn: () => void): void {
  checks++;
  fn();
}

const iosApp: CameraDevice = {
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WebinarLivApp/1.0",
  maxTouchPoints: 5,
  cores: 6,
};
const iphoneSafari: CameraDevice = {
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  maxTouchPoints: 5,
  cores: 6,
};
// iOS Chrome is WebKit with an iPhone UA too.
const iphoneChrome: CameraDevice = {
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  maxTouchPoints: 5,
  cores: 6,
};
// Eight cores: a flagship Android is a phone however fast it is.
const androidPhone: CameraDevice = {
  ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  maxTouchPoints: 5,
  cores: 8,
};
const ipad: CameraDevice = {
  ua: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  maxTouchPoints: 5,
  cores: 8,
};
// iPadOS desktop mode: a Mac UA with a touchscreen.
const ipadDesktopMode: CameraDevice = {
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  maxTouchPoints: 5,
  cores: 8,
};
const desktopChrome: CameraDevice = {
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  maxTouchPoints: 0,
  cores: 10,
};
const smallDesktop: CameraDevice = { ...desktopChrome, cores: 4 };

const sumBits = (plan: CameraPlan) =>
  [...plan.layers, plan.top].reduce((s, p) => s + p.encoding.maxBitrate, 0);

// ---------------------------------------------------------------- phones
console.log("phones");
for (const [name, device] of [
  ["iOS app (WKWebView)", iosApp],
  ["iPhone Safari", iphoneSafari],
  ["iPhone Chrome", iphoneChrome],
  ["Android phone", androidPhone],
] as const) {
  const plan = cameraPlanFor(device);
  check(() => assert.equal(plan.formFactor, "phone", name));
  // Capture: 720p ideal, and a hard cap so a camera cannot answer with 1080p again.
  check(() => assert.equal(plan.top, PHONE_CAMERA_TOP, name));
  check(() => assert.equal(plan.top.width, 1280, name));
  check(() => assert.equal(plan.top.height, 720, name));
  check(() => assert.ok((plan.top.encoding.maxFramerate ?? 0) >= 24 && (plan.top.encoding.maxFramerate ?? 0) <= 30, name));
  check(() => assert.deepEqual(plan.captureMax, { width: 1280, height: 1280, frameRate: 30 }, name));
  const opts = cameraCaptureOptions(plan) as Record<string, unknown>;
  check(() => assert.deepEqual(opts.width, { ideal: 1280, max: 1280 }, name));
  check(() => assert.deepEqual(opts.height, { ideal: 720, max: 1280 }, `${name}: portrait 720×1280 fits, 1920×1080 does not`));
  check(() => assert.deepEqual(opts.frameRate, { ideal: 24, max: 30 }, name));
  // Publish: 180p ~150, 360p ~450, top ~1.2 Mbps.
  check(() => assert.equal(plan.layers, PHONE_CAMERA_LAYERS, name));
  check(() => assert.deepEqual(plan.layers.map((l) => [l.width, l.height, l.encoding.maxBitrate]), [
    [320, 180, 150_000],
    [640, 360, 450_000],
  ], name));
  check(() => assert.equal(plan.top.encoding.maxBitrate, 1_200_000, name));
  check(() => assert.ok(sumBits(plan) <= 1_850_000, `${name}: ${sumBits(plan)} bps of camera`));
  // Priority: every camera encoding low.
  check(() => assert.equal(plan.priority, "low", name));
  check(() => assert.ok([...plan.layers, plan.top].every((p) => p.encoding.priority === "low"), name));
  check(() => assert.equal(plan.degradationPreference, "maintain-framerate", name));
  check(() => assert.equal(plan.ladder, PHONE_LADDER, name));
  check(() => assert.equal(plan.adapt, ADAPT.phoneCamera, name));
}

// ---------------------------------------------------------------- tablets and desktops: unchanged
console.log("tablets and desktops");
for (const [name, device, top] of [
  ["iPad", ipad, CAMERA_720],
  ["iPadOS desktop mode", ipadDesktopMode, CAMERA_720],
  ["desktop Chrome, 10 cores", desktopChrome, CAMERA_TOP],
  ["desktop, 4 cores", smallDesktop, CAMERA_720],
] as const) {
  const plan = cameraPlanFor(device);
  check(() => assert.notEqual(plan.formFactor, "phone", name));
  check(() => assert.equal(plan.top, top, name));
  check(() => assert.equal(plan.layers, CAMERA_LAYERS, name));
  check(() => assert.equal(plan.ladder, LADDER, name));
  check(() => assert.equal(plan.adapt, ADAPT.camera, name));
  check(() => assert.equal(plan.captureMax, undefined, `${name}: ideal only, as before`));
  check(() => assert.deepEqual(cameraCaptureOptions(plan), { resolution: top.resolution }, name));
  check(() => assert.equal(plan.priority, undefined, `${name}: spec default`));
  check(() => assert.equal(plan.degradationPreference, "maintain-framerate", name));
}
check(() => assert.equal(cameraPlanFor(desktopChrome).top.height, 1080));
check(() => assert.equal(cameraPlanFor(ipad).formFactor, "tablet"));
check(() => assert.equal(cameraPlanFor(desktopChrome).formFactor, "desktop"));

// ---------------------------------------------------------------- audio first
console.log("audio priority");
check(() => assert.equal(SPEECH_AUDIO.priority, "high"));
// Still the speech preset: 24 kbps Opus (RED doubles it).
check(() => assert.equal(SPEECH_AUDIO.maxBitrate, 24_000));

// ---------------------------------------------------------------- the live encodings on a phone
console.log("phone encodings");
{
  const phone = cameraPlanFor(iphoneSafari);
  const full = cameraEncodingPlan("full", "vp8", 3, phone.top.encoding.maxBitrate, 30, phone);
  check(() => assert.deepEqual(full.map((e) => e.maxBitrate), [150_000, 450_000, 1_200_000]));
  // The top stays at 24 fps on every re-apply, not the desktop's 30.
  check(() => assert.deepEqual(full.map((e) => e.maxFramerate), [15, 20, 24]));
  check(() => assert.deepEqual(cameraEncodingPlan("reduced", "vp8", 3, 1_200_000, 30, phone).map((e) => e.active), [true, true, false]));
  check(() => assert.deepEqual(
    cameraEncodingPlan("minimal", "vp8", 3, 1_200_000, 30, phone).map((e) => (e.active ? e.maxBitrate : 0)),
    [0, 450_000, 0],
  ));
  // No cliff: each step at most 5x.
  for (const tier of ["full", "reduced", "minimal"] as const) {
    const on = PHONE_LADDER[tier].map((r) => r.maxBitrate).filter((b) => b > 0);
    for (let i = 1; i < on.length; i++) check(() => assert.ok(on[i] / on[i - 1] <= 5, `${tier} step ${i}`));
  }
  // Desktop default unchanged.
  check(() => assert.deepEqual(cameraEncodingPlan("full", "vp8", 3, CAMERA_TOP.encoding.maxBitrate).map((e) => e.maxFramerate), [15, 20, 30]));
}

// ---------------------------------------------------------------- the phone ladder steps sooner
console.log("phone ladder");
{
  const run = (cfg: GovernorConfig, samples: Signals[]) => {
    let state = initialGovernor(cfg);
    let at = 0;
    for (const s of samples) {
      at += ADAPT.sampleMs;
      state = governorStep(cfg, state, s, at).state;
    }
    return state.level;
  };
  const clean: Signals = { loss: 0, rttExcess: 10, jitter: 5, headroom: 1, bandwidth: 0, cpu: 0 };
  const times = (n: number, s: Signals) => Array.from({ length: n }, () => s);

  // 1.5% loss for 6 s: the phone turns its top layer off; a desktop holds (its trigger is 2%).
  const mildLoss = times(4, { ...clean, loss: 1.5 });
  check(() => assert.equal(run(ADAPT.phoneCamera, mildLoss), 1, "phone: 1.5% loss → reduced"));
  check(() => assert.equal(run(ADAPT.camera, mildLoss), 0, "desktop: 1.5% loss holds"));

  // 150 ms of queueing for 6 s: phone steps, desktop (200 ms) holds.
  const queue = times(4, { ...clean, rttExcess: 150 });
  check(() => assert.equal(run(ADAPT.phoneCamera, queue), 1));
  check(() => assert.equal(run(ADAPT.camera, queue), 0));

  // The encoder bandwidth-limited for most of each window, 8 s: the phone gives way.
  const limited = times(5, { ...clean, bandwidth: 0.7 });
  check(() => assert.equal(run(ADAPT.phoneCamera, limited), 1, "phone: bandwidth-limited → reduced"));
  check(() => assert.equal(run(ADAPT.camera, limited), 0, "desktop ignores it"));
  // Not on the ramp-up: 4 s of it is not enough.
  check(() => assert.equal(run(ADAPT.phoneCamera, times(2, { ...clean, bandwidth: 1 })), 0, "a 4 s ramp is not congestion"));

  // CPU-limited phone: top off.
  check(() => assert.equal(run(ADAPT.phoneCamera, times(4, { ...clean, cpu: 0.8 })), 1));

  // One bad sample is a hiccup, still.
  check(() => assert.equal(run(ADAPT.phoneCamera, [{ ...clean, loss: 3 }, clean, clean]), 0));

  // Hysteresis: after a step down, 0.8% loss neither steps down again nor back up.
  const between = [...mildLoss, ...times(30, { ...clean, loss: 0.8 })];
  check(() => assert.equal(run(ADAPT.phoneCamera, between), 1, "0.8% sits in the band"));
  // And recovery waits the phone's longer clean window.
  check(() => assert.equal(run(ADAPT.phoneCamera, [...mildLoss, ...times(10, clean)]), 1, "20 s clean is not enough on a phone"));
  check(() => assert.equal(run(ADAPT.phoneCamera, [...mildLoss, ...times(17, clean)]), 0, "30 s clean steps back up"));

  // Every phone clear sits inside its trigger.
  for (const t of ADAPT.phoneCamera.down) {
    const c: Clear | undefined = ADAPT.phoneCamera.up.find((u) => u.signal === t.signal);
    check(() => assert.ok(c?.atMost !== undefined && c.atMost < t.atLeast, `${t.signal}: clear below trigger`));
  }
}

console.log(`\nPASS camera-plan (${checks} checks)`);
