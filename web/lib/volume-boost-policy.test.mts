/* Tests for lib/volume-boost-policy.ts. Run with `make test-web`. */

import {
  BOOST_MAX,
  BOOST_MIN,
  HEALTHY,
  STALLED_CHECKS,
  boostBlocker,
  boostBlockerText,
  clampBoost,
  readSource,
  talking,
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

// ---- readSource / talking
{
  const r1 = readSource({ audioLevel: 0.3, rtpTimestamp: 1000 }, undefined);
  ok(r1.kind === "level" && r1.level === 0.3, "first reading counts");
  const r2 = readSource({ audioLevel: 0.3, rtpTimestamp: 1960 }, 1000);
  ok(r2.kind === "level", "a moving RTP timestamp is fresh");
  ok(readSource({ audioLevel: 0.355, rtpTimestamp: 1000 }, 1000).kind === "stale", "a stuck RTP timestamp is stale: Chrome's ten-second leftover");
  ok(readSource({ rtpTimestamp: 1960 }, 1000).kind === "moving", "arriving without a level");
  ok(readSource({ rtpTimestamp: 1000 }, 1000).kind === "stale", "no level and stuck: stale");
  ok(readSource(undefined, 5).kind === "stale", "no source: stale");
  ok(talking({ kind: "level", level: 0.3 }, false), "a fresh level above the threshold is talking");
  ok(!talking({ kind: "level", level: 0.001 }, true), "a fresh level decides, whatever the SFU says");
  ok(talking({ kind: "moving" }, true) && !talking({ kind: "moving" }, false), "arriving without a level: the SFU decides");
  ok(!talking({ kind: "stale" }, true), "stale is never talking — not even with the SFU's (equally stale) flag set");
}
{
  // The reviewer's trail: the host talking, then the viewer's network blips. isSpeaking stays
  // true (no SFU messages arrive) and the room still reads connected for a few seconds.
  let h = HEALTHY;
  let prev: number | undefined;
  const check = (src: { audioLevel?: number; rtpTimestamp?: number }, rms: number) => {
    const r = readSource(src, prev);
    prev = src.rtpTimestamp;
    h = judgeBoost(h, [{ talking: talking(r, true), rms }], true);
  };
  check({ audioLevel: 0.3, rtpTimestamp: 1000 }, 0.1);
  check({ audioLevel: 0.3, rtpTimestamp: 49000 }, 0.1);
  check({ audioLevel: 0.3, rtpTimestamp: 60000 }, 0); // packets stopped mid-second
  for (let i = 0; i < 8; i++) check({ audioLevel: 0.3, rtpTimestamp: 60000 }, 0); // stuck
  ok(h.verdict === "ok", "a blip with a stale level and a stale isSpeaking does not fail the boost", `${h.verdict}/${h.stalled}`);
}

// ---- judgeBoost
const fed = (t: boolean) => ({ talking: t, rms: 0.1 });
const starved = (t: boolean) => ({ talking: t, rms: 0 });
{
  let h = HEALTHY;
  for (let i = 0; i < 20; i++) h = judgeBoost(h, [starved(false), starved(false)], true);
  ok(h.verdict === "ok" && h.stalled === 0, "nobody talking: nothing judged");
  for (let i = 0; i < 20; i++) h = judgeBoost(h, [starved(true)], false);
  ok(h.verdict === "ok" && h.stalled === 0, "room not connected (a reconnect): nothing judged");
  h = judgeBoost(HEALTHY, [], true);
  ok(h.verdict === "ok", "no streams: nothing judged");
}
{
  let h = HEALTHY;
  for (let i = 0; i < STALLED_CHECKS - 1; i++) h = judgeBoost(h, [starved(true)], true);
  ok(h.verdict === "ok", "a talker with nothing in the graph: not yet");
  h = judgeBoost(h, [starved(true)], true);
  ok(h.verdict === "failed", "…then failed after STALLED_CHECKS");
  ok(judgeBoost(h, [fed(true)], true).verdict === "failed", "failed stays failed");
}
{
  // The masking case: one stream fed (comfort noise), another talking and missing.
  let h = HEALTHY;
  for (let i = 0; i < STALLED_CHECKS; i++) h = judgeBoost(h, [fed(false), starved(true)], true);
  ok(h.verdict === "failed", "a missing talker is not hidden by another stream's audio");
}
{
  let h = HEALTHY;
  h = judgeBoost(h, [starved(true)], true);
  h = judgeBoost(h, [fed(true), fed(false)], true);
  ok(h.stalled === 0, "every talker reaching the graph clears the count");
}

// ---- rendererVolume
ok(rendererVolume({ active: false, everActive: false }) === undefined, "never used: renderer untouched");
ok(rendererVolume({ active: true, everActive: true }) === 0, "boosting: elements down to 0");
ok(rendererVolume({ active: false, everActive: true }) === 1, "back to 100% after a boost: explicitly 1, never left at 0");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
