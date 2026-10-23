/* Tests for lib/volume-boost-policy.ts. Run with `make test-web`. */

import {
  BOOST_MAX,
  BOOST_MIN,
  HEALTHY,
  STALLED_CHECKS,
  boostBlocker,
  boostBlockerText,
  clampBoost,
  isIOSLike,
  judgeBoost,
  rendererVolume,
} from "./volume-boost-policy.ts";

let failures = 0;
let checks = 0;
function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

// ---- clampBoost
ok(clampBoost(1) === 1 && clampBoost(2) === 2, "the ends are kept");
ok(clampBoost(0.5) === BOOST_MIN, "below 100% is 100%: the boost never turns anything down");
ok(clampBoost(5) === BOOST_MAX, "above the max is the max");
ok(clampBoost(1.26) === 1.3, "snapped to the step", String(clampBoost(1.26)));
ok(clampBoost(Number.NaN) === BOOST_MIN && clampBoost(Infinity) === BOOST_MIN, "garbage is 100%");

// ---- isIOSLike
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
const ipadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15";
const mac = ipadDesktop;
const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
ok(isIOSLike(iphone, 5), "iPhone");
ok(isIOSLike(ipadDesktop, 5), "an iPad asking for the desktop site");
ok(!isIOSLike(mac, 0), "a Mac");
ok(!isIOSLike(android, 5), "Android");

// ---- boostBlocker
const fine = {
  publisher: false,
  ios: false,
  lockScreen: false,
  speakerChosen: false,
  contextSinkSupported: false,
  supported: true,
  failed: false,
};
ok(boostBlocker(fine) === null, "an attendee on a desktop browser gets it");
ok(boostBlocker({ ...fine, publisher: true }) === "publisher", "anyone with a microphone does not");
ok(boostBlocker({ ...fine, ios: true }) === "ios", "iOS does not");
ok(boostBlocker({ ...fine, lockScreen: true }) === "lock-screen", "the Android lock-screen experiment keeps the volume");
ok(boostBlocker({ ...fine, speakerChosen: true }) === "speaker", "a chosen speaker the context cannot reach");
ok(boostBlocker({ ...fine, speakerChosen: true, contextSinkSupported: true }) === null, "a chosen speaker it can reach");
ok(boostBlocker({ ...fine, supported: false }) === "unsupported", "no Web Audio or no watchdog");
ok(boostBlocker({ ...fine, failed: true }) === "failed", "once failed, not offered again this session");
ok(boostBlocker({ ...fine, publisher: true, ios: true, failed: true }) === "publisher", "publisher wins: nothing is said to them");
ok(boostBlockerText("publisher") === null && boostBlockerText("lock-screen") === null, "silent blockers say nothing");
ok(typeof boostBlockerText("ios") === "string" && typeof boostBlockerText("failed") === "string", "the others explain");

// ---- judgeBoost
{
  let h = HEALTHY;
  for (let i = 0; i < 20; i++) h = judgeBoost(h, 0, 0);
  ok(h.verdict === "ok" && h.stalled === 0, "silence on the network and in the graph is just silence");
  h = judgeBoost(HEALTHY, null, 0);
  ok(h.verdict === "ok" && h.stalled === 0, "no network reading: nothing judged");
}
{
  let h = HEALTHY;
  for (let i = 0; i < STALLED_CHECKS - 1; i++) h = judgeBoost(h, 0.3, 0);
  ok(h.verdict === "ok", "speech with nothing in the graph: not yet");
  h = judgeBoost(h, 0.3, 0);
  ok(h.verdict === "failed", "…then failed after STALLED_CHECKS");
  ok(judgeBoost(h, 0.3, 0.2).verdict === "failed", "failed stays failed");
}
{
  let h = HEALTHY;
  h = judgeBoost(h, 0.3, 0);
  h = judgeBoost(h, 0.3, 0.05);
  ok(h.stalled === 0, "audio arriving in the graph resets the count");
}

// ---- rendererVolume
ok(rendererVolume({ active: false, everActive: false }) === undefined, "never used: renderer untouched");
ok(rendererVolume({ active: true, everActive: true }) === 0, "boosting: elements down to 0");
ok(rendererVolume({ active: false, everActive: true }) === 1, "back to 100% after a boost: explicitly 1, never left at 0");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
