/* Who receives AV1 (lib/receive-codecs.ts) — run with `make test-web`.
 *
 * Getting this wrong in one direction puts several software AV1 1080p decodes on the 4-vCPU
 * box that renders the edge mix; in the other, it costs a strong laptop the downlink saving.
 */

import assert from "node:assert/strict";
import { receiveAv1Verdict, withoutAv1, type ReceiveInputs } from "./receive-codecs.ts";

let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks++;
};

const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const HEADLESS = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";

const hw = { supported: true, smooth: true, powerEfficient: true };
const sw = { supported: true, smooth: true, powerEfficient: false };
const base: ReceiveInputs = { role: "participant", ua: DESKTOP, cores: 10, decoding: sw };
const v = (p: Partial<ReceiveInputs>) => receiveAv1Verdict({ ...base, ...p });

// The recorder never receives AV1, whatever the box reports.
for (const cores of [0, 2, 4, 8, 32]) {
  for (const decoding of [null, sw, hw]) {
    check(() => assert.deepEqual(v({ role: "recorder", ua: HEADLESS, cores, decoding }), { excludeAv1: true, reason: "recorder" }));
  }
}

// Desktops: AV1 unless ≤ 4 cores or decode is not supported / smooth. Software decode is fine.
check(() => assert.deepEqual(v({}), { excludeAv1: false, reason: "ok" }));
check(() => assert.equal(v({ decoding: null }).excludeAv1, false, "unknown decode on a strong desktop: keep"));
check(() => assert.equal(v({ cores: 0 }).excludeAv1, false, "unknown cores: not judged weak on cores"));
for (const cores of [1, 2, 4]) check(() => assert.equal(v({ cores, decoding: hw }).reason, `cores-${cores}`));
check(() => assert.equal(v({ cores: 6 }).excludeAv1, false));
check(() => assert.equal(v({ decoding: { supported: false, smooth: false, powerEfficient: false } }).reason, "decode-unsupported"));
check(() => assert.equal(v({ decoding: { supported: true, smooth: false, powerEfficient: false } }).reason, "decode-unsupported"));

// Phones: only with power-efficient (hardware) decode; unknown is "no".
check(() => assert.equal(v({ ua: ANDROID, cores: 8, decoding: null }).reason, "mobile-unknown"));
check(() => assert.equal(v({ ua: ANDROID, cores: 8, decoding: sw }).reason, "mobile-sw-decode"));
check(() => assert.equal(v({ ua: ANDROID, cores: 8, decoding: hw }).excludeAv1, false));
check(() => assert.equal(v({ ua: ANDROID, cores: 4, decoding: hw }).excludeAv1, true, "a 4-core phone even with hw decode"));
check(() => assert.equal(v({ ua: IPHONE, cores: 6, decoding: hw }).excludeAv1, false, "iPhone 15 Pro-class hw decode"));
check(() => assert.equal(v({ ua: IPHONE, cores: 6, decoding: sw }).excludeAv1, true));

// The codec list: only AV1 goes; RTX / RED / FEC and the backups stay.
const codecs = [
  { mimeType: "video/VP8" },
  { mimeType: "video/rtx" },
  { mimeType: "video/AV1" },
  { mimeType: "video/av1" },
  { mimeType: "video/H264" },
  { mimeType: "video/VP9" },
  { mimeType: "video/red" },
  { mimeType: "video/ulpfec" },
];
check(() =>
  assert.deepEqual(
    withoutAv1(codecs).map((c) => c.mimeType),
    ["video/VP8", "video/rtx", "video/H264", "video/VP9", "video/red", "video/ulpfec"],
  ),
);

console.log(`PASS receive-codecs (${checks} checks)`);
