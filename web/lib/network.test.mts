/* Tests for the playout-delay readout.
 *
 * Run with `make test-web`. One function, and it needs a test rather than a read for a
 * specific reason: it reports a NUMBER TO A USER who is troubleshooting, and a plausible
 * wrong number is worse than no number. The two ways to get it wrong both look fine on
 * screen — a lifetime average that stops responding after the first minute, and a stale
 * reading held over a window where no frames arrived — so neither is visible without
 * driving the counters by hand.
 *
 * Why this is worth pinning at all: it is the evidence for a claim in ARCHITECTURE.md §8d.
 * The measured playout delay (~10 ms against a ~280 ms round trip) is the reason the app
 * does NOT try to shorten the jitter buffer. If this function silently read low, that
 * conclusion would be built on an artefact.
 */

import { ConnectionQuality } from "livekit-client";
import {
  CAMERA_1080_BITRATE,
  CAMERA_720_BITRATE,
  CAMERA_TOP,
  LADDER,
  SHARE_720_MIN_BITRATE,
  SHARE_FLOOR_DESKTOP,
  SHARE_FLOOR_MOBILE,
  SHARE_LADDER,
  SHARE_LAYERS,
  SHARE_TOP,
  describeQuality,
  floorFrom,
  judge,
  judgeShare,
  needKbps,
  readPlayoutMs,
  shareNeedKbps,
  worseTier,
  type NetworkHealth,
  type PublishTier,
} from "./network.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

/** getStats returns a Map-shaped report, so a Map is the real thing here. */
function report(
  entries: {
    kind?: string;
    type?: string;
    jitterBufferDelay?: number;
    jitterBufferEmittedCount?: number;
  }[],
): RTCStatsReport {
  const map = new Map<string, unknown>();
  entries.forEach((e, i) =>
    map.set(`id${i}`, { type: "inbound-rtp", kind: "video", ...e }),
  );
  return map as unknown as RTCStatsReport;
}

console.log("\nreadPlayoutMs");

// A window average, not a lifetime one. 0.9s over 60 frames is 15ms a frame.
{
  const state = { delay: 0, count: 0, seeded: false };
  eq(
    readPlayoutMs(
      report([{ jitterBufferDelay: 0.9, jitterBufferEmittedCount: 60 }]),
      state,
    ),
    0,
    "the first sample has no window to average over and reports nothing",
  );
  eq(state.seeded, true, "…but it does establish the baseline");
  eq(
    Math.round(
      readPlayoutMs(
        report([{ jitterBufferDelay: 1.8, jitterBufferEmittedCount: 120 }]),
        state,
      ),
    ),
    15,
    "the second sample averages the delta: 0.9s over 60 frames is 15ms",
  );
  /* The property the comment in network.ts claims, made a test. The buffer jumps to 100ms a
   * frame for the next 60 frames. A lifetime average would report ~57ms and keep drifting
   * down for the rest of the session; a window average reports what is happening now. */
  eq(
    Math.round(
      readPlayoutMs(
        report([{ jitterBufferDelay: 7.8, jitterBufferEmittedCount: 180 }]),
        state,
      ),
    ),
    100,
    "a window average tracks a sudden change instead of diluting it",
  );
}

// No frames in the window. Reporting 0 would render as "no delay", which is a lie.
{
  const state = { delay: 1.5, count: 100, seeded: true };
  eq(
    readPlayoutMs(
      report([{ jitterBufferDelay: 1.5, jitterBufferEmittedCount: 100 }]),
      state,
    ),
    0,
    "a window with no frames reports 0 rather than dividing by zero",
  );
}

// Counters reset when a track is republished; a negative delta must not become a number.
{
  const state = { delay: 10, count: 500, seeded: true };
  eq(
    readPlayoutMs(
      report([{ jitterBufferDelay: 0.1, jitterBufferEmittedCount: 600 }]),
      state,
    ),
    0,
    "a counter reset does not produce a negative delay",
  );
  eq(
    state.delay,
    0.1,
    "…and the state still advances, so the next window is correct",
  );
}

// Only inbound video. Audio has its own buffer and screen shares are a separate track;
// folding either in would report a number that belongs to nothing on screen.
{
  const state = { delay: 0, count: 0, seeded: false };
  const mixed = new Map<string, unknown>([
    [
      "a",
      {
        type: "inbound-rtp",
        kind: "audio",
        jitterBufferDelay: 99,
        jitterBufferEmittedCount: 99,
      },
    ],
    [
      "b",
      {
        type: "outbound-rtp",
        kind: "video",
        jitterBufferDelay: 99,
        jitterBufferEmittedCount: 99,
      },
    ],
    [
      "c",
      {
        type: "inbound-rtp",
        kind: "video",
        jitterBufferDelay: 0.5,
        jitterBufferEmittedCount: 50,
      },
    ],
  ]) as unknown as RTCStatsReport;
  readPlayoutMs(mixed, state);
  eq(state.count, 50, "audio and outbound reports are ignored");
  eq(state.delay, 0.5, "…so only inbound video reaches the average");
}

/* The seed is only spent on a report that has frames in it.
 *
 * Somebody joining a live webinar samples before any video has arrived. Seeding on that
 * empty report would consume the baseline, and the NEXT sample — the first with real
 * numbers — would then be treated as a window and report the lifetime average after all. */
{
  const state = { delay: 0, count: 0, seeded: false };
  eq(
    readPlayoutMs(report([{}]), state),
    0,
    "an empty first report reports nothing",
  );
  eq(state.seeded, false, "…and does not consume the baseline");
  eq(
    readPlayoutMs(
      report([{ jitterBufferDelay: 3, jitterBufferEmittedCount: 100 }]),
      state,
    ),
    0,
    "so the first report WITH frames is still only a baseline",
  );
  eq(
    Math.round(
      readPlayoutMs(
        report([{ jitterBufferDelay: 4, jitterBufferEmittedCount: 150 }]),
        state,
      ),
    ),
    20,
    "and the window after it is a true 20ms average",
  );
}

// A browser that does not report the counters at all.
{
  const state = { delay: 0, count: 0, seeded: false };
  eq(
    readPlayoutMs(report([{}]), state),
    0,
    "missing counters report 0 rather than NaN",
  );
}

// ------------------------------------------------------- automatic publish quality

/* The ladder is now the only thing deciding what a presenter sends.
 *
 * The "Send video at" picker is gone, which means there is no longer a human to correct a
 * wrong decision here — a presenter cannot reach for 360p when the app leaves them on 720p
 * over a hotspot. That moves this from a nicety to the mechanism, so the cases below are the
 * ones that used to be a person's judgement.
 */

console.log("\nneedKbps");
{
  const full = needKbps("full");
  const reduced = needKbps("reduced");
  const minimal = needKbps("minimal");
  ok(full > reduced, "full costs more than reduced", `${full} vs ${reduced}`);
  ok(
    reduced > minimal,
    "reduced costs more than minimal",
    `${reduced} vs ${minimal}`,
  );
  // Derived from the rungs, so a preset change moves these rather than leaving them stale.
  ok(minimal > 0, "even the floor has a budget", String(minimal));
  ok(
    full < 10_000,
    "the top rung is a webcam, not a broadcast feed",
    String(full),
  );
}

console.log("\njudge");
{
  // A clean sample: no loss, and a round trip sitting ON this route's floor — no queue.
  const clean = { lossPercent: 0, rttMs: 40, rttFloorMs: 40 };

  // availableOutgoingBitrate must never vote — India→EU often reports nonsense Mbps.
  {
    const v = judge({ tier: "full", ...clean, availableOutgoingKbps: 0 });
    eq(v.bad, false, "a missing bandwidth estimate is not a reason to step down");
  }
  {
    const v = judge({ tier: "full", ...clean, availableOutgoingKbps: 600 });
    eq(
      v.bad,
      false,
      "a tiny browser estimate (0.6 Mbps) with clean loss/RTT does not step down",
    );
  }
  {
    const v = judge({ tier: "reduced", ...clean, availableOutgoingKbps: 600 });
    eq(
      v.good,
      true,
      "…and it does not hold a recovering presenter down either",
    );
  }

  // Already at the top: there is nowhere to grow, so `good` must be false or the
  // recovery counter fills up forever against a ceiling.
  {
    const v = judge({ tier: "full", ...clean });
    eq(v.good, false, "the top tier reports no room to grow");
  }

  // Loss and RTT are the only step-down signals.
  {
    eq(
      judge({
        tier: "full",
        lossPercent: 5,
        rttMs: 40,
        rttFloorMs: 40,
        availableOutgoingKbps: 99_999,
      }).bad,
      true,
      "packet loss steps down however wide the browser estimate looks",
    );
    eq(
      judge({
        tier: "full",
        lossPercent: 0,
        rttMs: 800,
        rttFloorMs: 40,
        availableOutgoingKbps: 99_999,
      }).bad,
      true,
      "so does 760ms of queueing on top of a 40ms route",
    );
  }

  /* Hysteresis on loss: between GOOD_LOSS (0.5) and BAD_LOSS (2) the ladder holds still. */
  {
    const mid = judge({
      tier: "reduced",
      lossPercent: 1,
      rttMs: 40,
      rttFloorMs: 40,
    });
    eq(mid.bad, false, "1% loss is not yet bad");
    eq(mid.good, false, "…and not yet good enough to climb");
  }
}

/* The bug this replaced, as tests.
 *
 * The thresholds used to be absolute: bad at rtt >= 300, good at rtt <= 180. This deployment's
 * SFU is on Hetzner EU with an audience in India, and the measured round trip is ~200–250 ms —
 * so a presenter was stepped down by ordinary jitter and could never climb back, because the
 * recovery condition required a latency the speed of light does not permit. Every case below
 * fails against those numbers and passes against a floor-relative excess.
 */
console.log("\na distant SFU is not a bad connection");
{
  /* The exact route this runs on. ~250 ms, stable, no loss, plenty of bandwidth: a perfectly
   * healthy call that happens to be several thousand kilometres long. */
  const distant = { rttMs: 250, rttFloorMs: 245, lossPercent: 0 };

  eq(
    judge({ tier: "full", ...distant, availableOutgoingKbps: 6_000 }).bad,
    false,
    "a stable 250ms EU↔IN route does not step a healthy presenter down",
  );

  // The part that made it permanent: recovery has to be reachable.
  eq(
    judge({ tier: "reduced", ...distant, availableOutgoingKbps: 6_000 }).good,
    true,
    "and a presenter already reduced on that route can climb back",
  );
  eq(
    judge({ tier: "minimal", ...distant, availableOutgoingKbps: 6_000 }).good,
    true,
    "…from the bottom rung too",
  );

  /* Jitter on a distant route. 300 ms against a 245 ms floor is 55 ms of queueing — nothing —
   * yet it is the exact reading the old absolute threshold fired on. */
  eq(
    judge({
      tier: "full",
      rttMs: 300,
      rttFloorMs: 245,
      lossPercent: 0,
      availableOutgoingKbps: 6_000,
    }).bad,
    false,
    "a 55ms wobble on a 245ms route is not congestion",
  );

  /* Long-haul jitter that used to trip the tighter 120ms excess threshold. */
  eq(
    judge({
      tier: "full",
      rttMs: 245 + 150,
      rttFloorMs: 245,
      lossPercent: 0,
      availableOutgoingKbps: 6_000,
    }).bad,
    false,
    "150ms of long-haul jitter on a 245ms floor is still not congestion",
  );

  /* And the same excess on a NEARBY route must still be quiet, or the rule has just moved the
   * arbitrary number somewhere else. */
  eq(
    judge({
      tier: "full",
      rttMs: 55,
      rttFloorMs: 28,
      lossPercent: 0,
      availableOutgoingKbps: 6_000,
    }).bad,
    false,
    "the same 27ms wobble on a 28ms route is not congestion either",
  );

  /* Real queueing, on both routes, at the same excess. This is the point of the change: the
   * verdict depends on the queue and not on where the server is. ~250ms+ of queueing still
   * steps down so a truly bad link (500ms+ absolute on a distant floor) degrades. */
  for (const floor of [28, 245]) {
    eq(
      judge({
        tier: "full",
        rttMs: floor + 250,
        rttFloorMs: floor,
        lossPercent: 0,
        availableOutgoingKbps: 6_000,
      }).bad,
      true,
      `250ms of queueing on a ${floor}ms route steps down`,
    );
    eq(
      judge({
        tier: "reduced",
        rttMs: floor + 250,
        rttFloorMs: floor,
        lossPercent: 0,
        availableOutgoingKbps: 6_000,
      }).good,
      false,
      `…and does not want to climb while the queue is there (${floor}ms route)`,
    );
  }

  /* The first sample after connecting, which is the worst of the session: the connection is
   * still ramping, and there is no floor to compare against yet. Latency must have no vote,
   * or the ladder steps a healthy presenter down before the call has started — which is
   * exactly when the user reported the lag appearing. */
  eq(
    judge({
      tier: "full",
      rttMs: 900,
      rttFloorMs: 0,
      lossPercent: 0,
      availableOutgoingKbps: 6_000,
    }).bad,
    false,
    "an unmeasured floor gives latency no vote",
  );
  eq(
    judge({
      tier: "full",
      rttMs: 0,
      rttFloorMs: 0,
      lossPercent: 0,
      availableOutgoingKbps: 6_000,
    }).bad,
    false,
    "…and neither does an unmeasured round trip",
  );
}

/* The gap between adjacent layers, which is the bug that reached a customer.
 *
 * The screen share published exactly two layers: 640x360 at 200 kbps and 1920x1080 at 2500.
 * adaptiveStream chooses per subscriber from whatever is published, so anybody who could not
 * sustain 2.5 Mbps did not step down a rung — there was no rung — they fell 12.5x to 360p at
 * three frames a second. On a slide that is unreadable, and it was reported as "the screen
 * share quality is poor".
 *
 * Nothing about that is visible on screen for whoever changes these tables: the presenter's
 * own view is the capture, and a developer on a fast connection always gets the top layer. So
 * the property is pinned here instead — no two consecutive live layers may be more than
 * MAX_STEP apart.
 *
 * 5x, not 4x: the camera's own widest step is 450 -> 1700 kbps, which is 3.8x and fine. The
 * threshold is set to catch an order-of-magnitude hole, not to dictate the ladder.
 */
console.log("\nladder shape");
{
  const MAX_STEP = 5;
  const tiers: PublishTier[] = ["full", "reduced", "minimal"];

  // Encodings are the simulcast layers PLUS the top one, which the SDK takes separately as
  // screenShareEncoding. applyLadder indexes the ladder by encoding position, so a mismatch
  // means a real layer silently inherits some other rung's budget.
  const shareEncodings = SHARE_LAYERS.length + 1;
  eq(shareEncodings, 3, "the share publishes three encodings");

  for (const tier of tiers) {
    // Camera: rungs are the ladder's own, so this only checks the gaps.
    const camera = LADDER[tier].map((r) => r.maxBitrate).filter((b) => b > 0);
    for (let i = 1; i < camera.length; i++) {
      const step = camera[i] / camera[i - 1];
      ok(
        step <= MAX_STEP,
        `camera ${tier}: no cliff between layers`,
        `${camera[i - 1]} -> ${camera[i]} is ${step.toFixed(1)}x`,
      );
    }

    const share = needKbps(tier, true);
    ok(share > 0, `share budget for ${tier} is a number`, String(share));
  }
}

/* And the same claim for the share, which is where the hole actually was.
 *
 * Read off SHARE_LADDER, not off the presets. The presets set each layer's bitrate at PUBLISH
 * time and applyLadder overwrites it on the first tier decision, so the rungs are what a
 * subscriber can actually be given. An earlier version of this test read the presets and
 * therefore passed while `full` still had a 7.5x hole in it.
 */
console.log("\nshare layer gaps");
{
  const MAX_STEP = 5;
  const tiers: PublishTier[] = ["full", "reduced", "minimal"];

  for (const tier of tiers) {
    // Rung count has to equal the encoding count, or applyLadder indexes past the end and a
    // real layer inherits the last rung's budget.
    eq(
      SHARE_LADDER[tier].length,
      SHARE_LAYERS.length + 1,
      `share ${tier}: one rung per encoding`,
    );

    const live = SHARE_LADDER[tier]
      .map((r) => r.maxBitrate)
      .filter((b) => b > 0);
    for (let i = 1; i < live.length; i++) {
      const step = live[i] / live[i - 1];
      ok(
        step <= MAX_STEP,
        `share ${tier}: no cliff between layers`,
        `${live[i - 1]} -> ${live[i]} is ${step.toFixed(1)}x`,
      );
    }
  }

  // The specific regression, named: a tiny low rung must not jump straight to the 1080p ceiling.
  const full = SHARE_LADDER.full.map((r) => r.maxBitrate);
  ok(
    full.length >= 3,
    "the share has a middle layer at all",
    `rungs: ${full.join(", ")}`,
  );
  ok(
    full[1] >= 2_500_000 && full[1] <= 3_500_000,
    "the middle share rung is ~3 Mbps so 720p text stays sharp",
    `${full[1]} bps`,
  );

  // And the middle layer is 720p at a watchable frame rate — the point of building it by hand
  // rather than taking h720fps5, whose 5fps cap would pin a subscriber there.
  const middle = SHARE_LAYERS[1];
  eq(middle.height, SHARE_FLOOR_DESKTOP.height, "the middle share layer is 720p");
  eq(middle.width, SHARE_FLOOR_DESKTOP.width, "…at desktop floor width");
  ok(
    (middle.encoding.maxFramerate ?? 0) >= 10,
    "the middle share layer is not frame-rate capped into a slideshow",
    `${middle.encoding.maxFramerate}fps`,
  );

  // Desktop content floor: every tier keeps a ≥720p layer live at the bitrate floor.
  for (const tier of tiers) {
    const rung720 = SHARE_LADDER[tier][1];
    ok(
      rung720.maxBitrate >= SHARE_720_MIN_BITRATE,
      `share ${tier}: 720p rung stays at or above the bitrate floor`,
      `${rung720.maxBitrate}`,
    );
  }
  eq(
    SHARE_LADDER.minimal[1].maxFramerate,
    8,
    "minimal holds 720p pixels and cuts fps instead of bitrate",
  );
  eq(
    SHARE_FLOOR_MOBILE.height,
    360,
    "mobile capture/encode floor is 360p",
  );
  ok(
    SHARE_TOP.height >= SHARE_FLOOR_DESKTOP.height,
    "top share layer is above the desktop floor",
  );
  ok(
    SHARE_TOP.encoding.maxBitrate >= 4_000_000,
    "1080p share ceiling has Zoom-like headroom for fine text",
    `${SHARE_TOP.encoding.maxBitrate}`,
  );
}

/* Camera layers: 1080p top under Zoom's Full HD send budget; 720p mid for grids. */
console.log("\ncamera layer budgets");
{
  ok(
    CAMERA_TOP.height === 1080,
    "camera top layer is 1080p",
    `${CAMERA_TOP.width}x${CAMERA_TOP.height}`,
  );
  ok(
    CAMERA_TOP.encoding.maxBitrate >= 3_000_000 &&
      CAMERA_TOP.encoding.maxBitrate <= 3_800_000,
    "camera 1080p is ~3.2 Mbps (under Zoom's ~3.8 Mbps Full HD send)",
    `${CAMERA_TOP.encoding.maxBitrate}`,
  );
  eq(
    LADDER.full[2].maxBitrate,
    CAMERA_1080_BITRATE,
    "camera ladder top matches the published 1080p bitrate",
  );
  eq(
    LADDER.full[1].maxBitrate,
    CAMERA_720_BITRATE,
    "camera mid rung is the 720p layer",
  );
  ok(
    LADDER.full[1].maxBitrate >= 1_800_000,
    "camera mid layer stays in Zoom's common 720p HD band",
    `${LADDER.full[1].maxBitrate}`,
  );
  eq(
    LADDER.reduced[2].maxBitrate,
    0,
    "reduced turns off 1080p and keeps 720p for large-but-not-full tiles",
  );
}

/* Share degradation must not follow the camera's RTT ladder, and must never use
 * availableOutgoingBitrate — that figure falsely reduced healthy India→EU presenters.
 */
console.log("\njudgeShare vs camera while sharing");
{
  const distant = {
    lossPercent: 0,
    rttMs: 250,
    rttFloorMs: 245,
  };

  /* Screenshot + peer reports: 5.7 Mbps or 0.6 Mbps browser estimate on 100 Mbps+ ISP,
   * clean loss/RTT. Must stay at full for both camera and share. */
  for (const kbps of [5_700, 600, 0]) {
    const sample = {
      ...distant,
      rttMs: 143,
      rttFloorMs: 141,
      availableOutgoingKbps: kbps,
    };
    eq(
      judge({ tier: "full", ...sample, sharing: true }).bad,
      false,
      `${kbps || "missing"} kbps estimate does not step the camera down`,
    );
    eq(
      judgeShare({ tier: "full", ...sample }).bad,
      false,
      `…nor the share (${kbps || "missing"} kbps)`,
    );
  }

  eq(
    judge({
      tier: "reduced",
      ...distant,
      rttMs: 143,
      rttFloorMs: 141,
      availableOutgoingKbps: 600,
      sharing: true,
    }).good,
    true,
    "a camera already reduced on a clean link can climb back regardless of estimate",
  );

  // Mild loss that moves the camera must not blur slides.
  eq(
    judge({
      tier: "full",
      lossPercent: 2.5,
      rttMs: 40,
      rttFloorMs: 40,
    }).bad,
    true,
    "2.5% loss is enough for the camera ladder",
  );
  eq(
    judgeShare({
      tier: "full",
      lossPercent: 2.5,
      rttMs: 40,
      rttFloorMs: 40,
    }).bad,
    false,
    "…but not for the share (needs severe loss)",
  );

  eq(
    judgeShare({
      tier: "full",
      lossPercent: 6,
      rttMs: 40,
      rttFloorMs: 40,
    }).bad,
    true,
    "severe packet loss does step the share down",
  );

  eq(
    judgeShare({
      tier: "full",
      lossPercent: 0,
      rttMs: 40 + 450,
      rttFloorMs: 40,
    }).bad,
    true,
    "extreme queueing does step the share down",
  );

  // Even after stepping to reduced, the 720p rung stays at the readable floor.
  eq(
    SHARE_LADDER.reduced[1].maxBitrate,
    SHARE_720_MIN_BITRATE,
    "reduced still publishes 720p at the bitrate floor (turns off 1080p only)",
  );

  eq(
    worseTier("full", "minimal"),
    "minimal",
    "worseTier picks the more degraded rung",
  );
  eq(worseTier("reduced", "full"), "reduced", "…from either argument order");
}

console.log("\nfloorFrom");
{
  eq(floorFrom([]), 0, "nothing measured yet is 0, meaning unknown");
  eq(
    floorFrom([0, 0]),
    0,
    "readings of 0 are 'not measured', not a floor of zero",
  );
  eq(
    floorFrom([280, 310, 285, 279, 340]),
    279,
    "the floor is the best of the window",
  );
  eq(floorFrom([0, 300, 0, 288]), 288, "…ignoring the unmeasured ones");
  eq(
    floorFrom([42]),
    42,
    "one reading is its own floor, so its excess is zero",
  );
  /* A window, not an all-time minimum: the floor has to be able to RISE. Somebody moving from
   * wifi to a hotspot mid-call would otherwise be judged forever against a floor their new
   * route cannot reach — the same permanent-degradation failure in a different guise. */
  eq(
    floorFrom([300, 305, 298]),
    298,
    "once the old low readings have aged out, the floor follows the new route up",
  );
}

/* Ladder cost tables (documentation only — not used by judge). Sharing still costs more. */
{
  const cameraOnly = needKbps("full");
  const withShare = needKbps("full", true);
  ok(
    withShare > cameraOnly * 2,
    `sharing at least doubles the documented budget (${cameraOnly} -> ${withShare})`,
  );
  ok(
    needKbps("full", true) > needKbps("reduced", true) &&
      needKbps("reduced", true) > needKbps("minimal", true),
    "the sharing budget shrinks monotonically down the ladder",
  );
  ok(
    shareNeedKbps("full") > shareNeedKbps("reduced"),
    "share-alone full costs more than reduced (1080p off)",
  );

  // Clean loss/RTT must stay full even when the browser estimate looks tiny.
  const sample = {
    tier: "full" as PublishTier,
    lossPercent: 0,
    rttMs: 300,
    rttFloorMs: 295,
    availableOutgoingKbps: 600,
  };
  ok(!judge(sample).bad, "0.6 Mbps estimate does not degrade the camera");
  ok(
    !judge({ ...sample, sharing: true }).bad,
    "…even while sharing",
  );
  ok(!judgeShare(sample).bad, "…and does not degrade the share either");

  ok(
    judge({
      tier: "minimal",
      lossPercent: 0,
      rttMs: 300,
      rttFloorMs: 298,
      availableOutgoingKbps: 600,
      sharing: true,
    }).good,
    "clean loss/RTT steps a sharing presenter back up regardless of estimate",
  );
}

/* The banner: ~250 ms to Hetzner EU must not read as poor / reduced by default. */
console.log("\ndescribeQuality for EU SFU + IN clients");
{
  const base: NetworkHealth = {
    quality: ConnectionQuality.Good,
    lossPercent: 0,
    rttMs: 250,
    rttFloorMs: 245,
    jitterMs: 5,
    playoutMs: 10,
    availableOutgoingKbps: 6_000,
    tier: "full",
    degraded: false,
  };

  eq(
    describeQuality(base),
    { label: "Good connection", tone: "ok" },
    "a stable 250ms route is good, not a warn banner",
  );
  eq(
    describeQuality({ ...base, quality: ConnectionQuality.Poor }),
    { label: "Good connection", tone: "ok" },
    "LiveKit Poor on an expected EU↔IN route does not override healthy local stats",
  );
  eq(
    describeQuality({ ...base, quality: ConnectionQuality.Excellent }),
    { label: "Strong connection", tone: "ok" },
    "Excellent stays strong",
  );
  eq(
    describeQuality({ ...base, degraded: true, tier: "reduced" }),
    { label: "Reduced quality", tone: "warn" },
    "a real ladder step still shows reduced quality",
  );
  eq(
    describeQuality({
      ...base,
      quality: ConnectionQuality.Poor,
      rttMs: 520,
      rttFloorMs: 245,
    }),
    { label: "Poor connection", tone: "bad" },
    "500ms+ with real queueing still flags poor",
  );
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
