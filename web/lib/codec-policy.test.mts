/* Who publishes AV1 (lib/codec-policy.ts) — run with `make test-web`.
 *
 * The rule that matters most is the one no capability API can be trusted for: Safari and every
 * iPhone / iPad browser never publish AV1, whatever they report. Then the device gate: the
 * encoder must exist, MediaCapabilities must say supported AND smooth, and software encode needs
 * the cores. Every row here is a browser a presenter really joins from.
 */

import assert from "node:assert/strict";
import { av1Verdict, isAppleWebKit, type Av1Inputs } from "./codec-policy.ts";
import { shareCodec, isSvcShareCodec } from "./share-mode.ts";

let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks++;
};

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
  chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1",
  iphoneEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/155.0 Mobile/15E148 Safari/605.1.15",
  ipadUa:
    "Mozilla/5.0 (iPad; CPU OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:135.0) Gecko/20100101 Firefox/135.0",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
};

const AV1_CODECS = ["video/VP8", "video/VP9", "video/H264", "video/AV1", "video/rtx"];
const capable: Av1Inputs = {
  ua: UA.chromeMac,
  maxTouchPoints: 0,
  cores: 10,
  deviceMemoryGb: 8,
  senderCodecs: AV1_CODECS,
  encoding: { supported: true, smooth: true, powerEfficient: false },
  height: 1080,
  demoted: false,
};
const v = (patch: Partial<Av1Inputs>) => av1Verdict({ ...capable, ...patch });

// ---------------------------------------------------------------- desktop Chromium: yes
for (const ua of [UA.chromeMac, UA.chromeWin, UA.edgeWin, UA.chromeLinux]) {
  check(() => assert.deepEqual(v({ ua }), { av1: true, reason: "sw" }, ua));
}
check(() => assert.equal(v({ encoding: { supported: true, smooth: true, powerEfficient: true } }).reason, "hw"));

// ---------------------------------------------------------------- Apple WebKit: never
/* Everything maxed out — AV1 listed, supported, smooth, power-efficient, 16 cores — and still no.
 * Safari advertises AV1 on devices it cannot publish it from, and every iOS browser is Safari. */
const maxed: Partial<Av1Inputs> = {
  cores: 16,
  deviceMemoryGb: 8,
  senderCodecs: AV1_CODECS,
  encoding: { supported: true, smooth: true, powerEfficient: true },
};
for (const [ua, touch] of [
  [UA.safariMac, 0],
  [UA.iphoneSafari, 5],
  [UA.iphoneChrome, 5],
  [UA.iphoneEdge, 5],
  [UA.ipadUa, 5],
  // iPadOS's default "desktop website" UA is a Mac one; only the touch points give it away.
  [UA.safariMac, 5],
  [UA.chromeMac.replace("Chrome/155.0.0.0 ", ""), 5],
] as const) {
  check(() => assert.equal(isAppleWebKit(ua, touch), true, ua));
  check(() => assert.deepEqual(v({ ...maxed, ua, maxTouchPoints: touch }), { av1: false, reason: "safari-ios" }, ua));
  for (const height of [360, 720, 1080]) {
    check(() => assert.equal(v({ ...maxed, ua, maxTouchPoints: touch, height }).av1, false));
  }
}
check(() => assert.equal(isAppleWebKit(UA.chromeMac, 0), false));
check(() => assert.equal(isAppleWebKit(UA.edgeWin, 0), false));
check(() => assert.equal(isAppleWebKit(UA.android, 5), false));

// ---------------------------------------------------------------- Firefox: no (no AV1 SVC publish)
check(() => assert.equal(v({ ...maxed, ua: UA.firefox }).reason, "firefox"));

// ---------------------------------------------------------------- the device gate
check(() => assert.equal(v({ senderCodecs: null }).reason, "no-capabilities-api"));
check(() => assert.equal(v({ senderCodecs: ["video/VP8", "video/VP9", "video/H264"] }).reason, "no-av1-encoder"));
check(() => assert.equal(v({ senderCodecs: ["video/av1"] }).av1, true, "mimeType case-insensitive"));
check(() => assert.equal(v({ encoding: null }).reason, "no-media-capabilities"));
check(() => assert.equal(v({ encoding: { supported: false, smooth: false, powerEfficient: false } }).reason, "encode-unsupported"));
check(() => assert.equal(v({ encoding: { supported: true, smooth: false, powerEfficient: true } }).reason, "encode-not-smooth"));
// Software AV1 needs 8 cores, at any size.
check(() => assert.equal(v({ cores: 4 }).reason, "cores-4<8"));
check(() => assert.equal(v({ cores: 6, height: 720 }).av1, false));
check(() => assert.equal(v({ cores: 0 }).av1, false, "unknown cores: no"));
check(() => assert.equal(v({ cores: 8 }).av1, true));
// A hardware encoder may go below 1080p on 4 cores — but 1080p still needs 8.
const hw = { supported: true, smooth: true, powerEfficient: true };
check(() => assert.equal(v({ cores: 4, height: 720, encoding: hw }).av1, true));
check(() => assert.equal(v({ cores: 4, height: 1080, encoding: hw }).av1, false));
check(() => assert.equal(v({ cores: 2, height: 720, encoding: hw }).av1, false));

// ---------------------------------------------------------------- phones
check(() => assert.equal(v({ ua: UA.android, cores: 8, deviceMemoryGb: 8 }).reason, "mobile-low-end", "software on a phone"));
check(() => assert.equal(v({ ua: UA.android, cores: 4, deviceMemoryGb: 4, encoding: hw }).reason, "mobile-low-end"));
check(() => assert.equal(v({ ua: UA.android, cores: 8, deviceMemoryGb: 8, encoding: hw }).av1, true, "flagship + hw encoder"));

// ---------------------------------------------------------------- switches
check(() => assert.deepEqual(v({ demoted: true }), { av1: false, reason: "cpu-demoted" }));
check(() => assert.deepEqual(v({ disabled: true }), { av1: false, reason: "disabled" }));

// ---------------------------------------------------------------- share codec follows the gate
check(() => assert.equal(shareCodec(UA.chromeMac, true), "av1"));
check(() => assert.equal(shareCodec(UA.chromeMac, false), "vp9"));
check(() => assert.equal(shareCodec(UA.chromeMac), "vp9"));
// Even a wrong `true` cannot put Safari / iOS / Firefox / phones on AV1: they are H264 shares.
for (const ua of [UA.safariMac, UA.iphoneSafari, UA.iphoneChrome, UA.ipadUa, UA.firefox, UA.android]) {
  check(() => assert.equal(shareCodec(ua, true), "h264", ua));
}
check(() => assert.equal(isSvcShareCodec("av1"), true));
check(() => assert.equal(isSvcShareCodec("h264"), false));

console.log(`PASS codec-policy (${checks} checks)`);
