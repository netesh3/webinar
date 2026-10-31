/* The adaptation rules, replayed against synthetic stat streams — run with `make test-web`.
 *
 * Every rule here is about what happens BETWEEN samples (holds, clean windows, cool-downs,
 * oscillation), which no live call can be made to demonstrate on demand. The streams are 2 s
 * samples, as useNetworkHealth takes them, through the real ADAPT table in network.ts.
 */

import assert from "node:assert/strict";
import {
  cpuLimitedShare,
  governorStep,
  initialGovernor,
  type Decision,
  type GovernorConfig,
  type GovernorState,
  type Signals,
} from "./adapt-governor.ts";
import {
  ADAPT,
  AV1_SAVING,
  CAMERA_1080_BITRATE,
  CAMERA_720_BITRATE,
  CPU_STEPS,
  LADDER,
  SHARE_BITRATES,
  SHARE_SINGLE_BITRATES,
  cameraCodecOfTrack,
  cameraEncodingPlan,
  cameraLadder,
  cameraPublishDefaults,
  cpuLanding,
  cpuReleaseIsNoop,
  cpuStepApplies,
  headroomOf,
  shareCodecOfTrack,
  shareEncodingPlan,
  shareLadder,
  type CpuStep,
} from "./network.ts";

let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks++;
};

const STEP = ADAPT.sampleMs;

/** Replays `samples` (one per 2 s) through a governor; returns every move with its time. */
function replay(
  cfg: GovernorConfig,
  samples: Signals[],
  opts: { start?: GovernorState; floor?: (i: number) => number } = {},
): { moves: (Decision & { at: number })[]; state: GovernorState } {
  let state = opts.start ?? initialGovernor(cfg);
  const moves: (Decision & { at: number })[] = [];
  samples.forEach((s, i) => {
    const now = (i + 1) * STEP;
    const r = governorStep(cfg, state, s, now, opts.floor?.(i) ?? 0);
    state = r.state;
    if (r.decision) moves.push({ ...r.decision, at: now });
  });
  return { moves, state };
}
const times = <T,>(n: number, s: T): T[] => Array.from({ length: n }, () => s);

const clean: Signals = { loss: 0, rttExcess: 10, jitter: 5, headroom: 1, cpu: 0 };

// ---------------------------------------------------------------- hold before stepping down
console.log("hold");
{
  // loss 6% (>= 2% camera trigger) must hold 4 s: true at t=2,4 → not yet; t=6 → fires (4 s span).
  const { moves } = replay(ADAPT.camera, [...times(3, { ...clean, loss: 6 })]);
  check(() => assert.equal(moves.length, 1));
  check(() => assert.equal(moves[0].at, 6000, "fires once the condition has held 4 s"));
  check(() => assert.match(moves[0].reason, /^loss 6 >= 2 for 4s/));
}
{
  // A single bad sample between clean ones is a hiccup.
  const { moves } = replay(ADAPT.camera, [clean, { ...clean, loss: 8 }, clean, { ...clean, loss: 8 }, clean]);
  check(() => assert.equal(moves.length, 0, "isolated spikes never step"));
}
{
  // Severe: >= 10% for 2 s fires on the second sample.
  const { moves } = replay(ADAPT.camera, times(2, { ...clean, loss: 20 }));
  check(() => assert.equal(moves[0]?.at, 4000));
  check(() => assert.match(moves[0].reason, /severe/));
}
{
  // Share: 4% loss is below its 5% bar however long it lasts; 6% holds 4 s; 16% is severe.
  check(() => assert.equal(replay(ADAPT.share, times(20, { ...clean, loss: 4 })).moves.length, 0));
  check(() => assert.equal(replay(ADAPT.share, times(3, { ...clean, loss: 6 })).moves[0]?.at, 6000));
  check(() => assert.equal(replay(ADAPT.share, times(2, { ...clean, loss: 16 })).moves[0]?.at, 4000));
}
{
  // Queueing and jitter triggers, and unknown signals never fire.
  check(() => assert.equal(replay(ADAPT.camera, times(3, { ...clean, rttExcess: 250 })).moves.length, 1));
  check(() => assert.equal(replay(ADAPT.camera, times(3, { ...clean, jitter: 120 })).moves.length, 0, "jitter holds 6 s"));
  check(() => assert.equal(replay(ADAPT.camera, times(4, { ...clean, jitter: 120 })).moves.length, 1));
  check(() =>
    assert.equal(replay(ADAPT.camera, times(30, { loss: undefined, rttExcess: undefined, jitter: undefined })).moves.length, 0),
  );
}

// ---------------------------------------------------------------- one step at a time + cool-down
console.log("cool-down and one step per sample");
{
  // Sustained 6% loss: full → reduced at 6 s, then nothing for the 10 s cool-down, then the
  // trigger has to hold its 4 s again (its timer restarted at the move).
  const { moves } = replay(ADAPT.camera, times(15, { ...clean, loss: 6 }));
  check(() => assert.deepEqual(moves.map((m) => [m.from, m.to, m.at]), [[0, 1, 6000], [1, 2, 16000]]));
}
{
  // Severe bypasses the cool-down: a collapse right after a move steps again at once.
  const { moves } = replay(ADAPT.camera, [...times(3, { ...clean, loss: 6 }), ...times(2, { ...clean, loss: 30 })]);
  check(() => assert.deepEqual(moves.map((m) => m.at), [6000, 10000]));
}
{
  // Never below the bottom rung.
  const { moves, state } = replay(ADAPT.camera, times(60, { ...clean, loss: 30 }));
  check(() => assert.equal(state.level, ADAPT.camera.maxLevel));
  check(() => assert.equal(moves.length, ADAPT.camera.maxLevel));
}

// ---------------------------------------------------------------- clean window + hysteresis
console.log("clean window and hysteresis");
{
  const down = replay(ADAPT.camera, times(3, { ...clean, loss: 6 }));
  // 20 s of clean, starting at the next sample: the step up comes exactly cleanMs later.
  const up = replay(ADAPT.camera, times(12, clean), { start: down.state });
  check(() => assert.equal(up.moves.length, 1));
  check(() => assert.equal(up.moves[0].direction, "up"));
  check(() => assert.equal(up.moves[0].at, 2000 + ADAPT.camera.cleanMs, "clean 20 s, counted from the first clean sample"));
}
{
  // The hysteresis band: 1% loss neither steps down (< 2%) nor counts as clean (> 0.5%).
  const down = replay(ADAPT.camera, times(3, { ...clean, loss: 6 }));
  const band = replay(ADAPT.camera, times(60, { ...clean, loss: 1 }), { start: down.state });
  check(() => assert.equal(band.moves.length, 0, "a link sitting on 1% holds still"));
  // One dirty sample restarts the clean window.
  const dirty = replay(
    ADAPT.camera,
    [...times(9, clean), { ...clean, rttExcess: 120 }, ...times(9, clean)],
    { start: down.state },
  );
  check(() => assert.equal(dirty.moves.length, 0, "a miss inside the window restarts it"));
  // Headroom under 30% blocks recovery; unknown headroom does not.
  check(() => assert.equal(replay(ADAPT.camera, times(30, { ...clean, headroom: 0.1 }), { start: down.state }).moves.length, 0));
  check(() => assert.equal(replay(ADAPT.camera, times(30, { ...clean, headroom: undefined }), { start: down.state }).moves.length, 1));
}

// ---------------------------------------------------------------- oscillation ceiling
console.log("oscillation");
{
  // Bad 6 s, clean 20 s, bad 6 s …: the third move inside two minutes arms the hold, after
  // which nothing climbs for two minutes even though the link is clean.
  const bad = times(3, { ...clean, loss: 6 });
  const good = times(11, clean);
  const { moves } = replay(ADAPT.camera, [...bad, ...good, ...times(6, { ...clean, loss: 6 }), ...times(80, clean)]);
  check(() => assert.deepEqual(moves.slice(0, 3).map((m) => m.direction), ["down", "up", "down"]));
  check(() => assert.match(moves[2].reason, /oscillation: 3 changes in 120s, holding 120s/));
  const third = moves[2].at;
  const nextUp = moves[3];
  check(() => assert.ok(nextUp, "it does recover eventually"));
  check(() => assert.ok(nextUp.at >= third + ADAPT.camera.oscillation.holdMs, `held until ${third + 120_000}, moved at ${nextUp.at}`));
}
{
  // During the hold a non-severe trigger does not step down; a severe one does.
  const bad = times(3, { ...clean, loss: 6 });
  const good = times(11, clean);
  const armed = replay(ADAPT.camera, [...bad, ...good, ...times(6, { ...clean, loss: 6 })]).state;
  const mild = replay(ADAPT.camera, [...times(6, clean), ...times(10, { ...clean, loss: 6 })], { start: armed });
  check(() => assert.equal(mild.moves.length, 0));
  const severe = replay(ADAPT.camera, [...times(6, clean), ...times(2, { ...clean, loss: 30 })], { start: armed });
  check(() => assert.equal(severe.moves.length, 1));
}

// ---------------------------------------------------------------- floor
console.log("floor");
{
  // Sharing holds the camera at "reduced" immediately, without waiting for anything.
  const { moves } = replay(ADAPT.camera, times(30, clean), { floor: () => 1 });
  check(() => assert.deepEqual(moves.map((m) => [m.to, m.reason]), [[1, "floor"]]));
  // When the share ends, recovery is a normal clean window — measured on the network, so the
  // clean seconds during the share count (from the first clean sample after the floor move).
  const after = replay(ADAPT.camera, times(30, clean), { floor: (i) => (i < 5 ? 1 : 0) });
  check(() => assert.deepEqual(after.moves.map((m) => m.to), [1, 0]));
  check(() => assert.equal(after.moves[1].at, 4000 + ADAPT.camera.cleanMs));
  // A dirty share period means the full window starts after it.
  const dirty = replay(
    ADAPT.camera,
    [...times(5, { ...clean, loss: 1 }), ...times(20, clean)],
    { floor: (i) => (i < 5 ? 1 : 0) },
  );
  check(() => assert.equal(dirty.moves[1]?.at, 12_000 + ADAPT.camera.cleanMs));
}

// ---------------------------------------------------------------- CPU signal
console.log("cpu signal");
{
  const prev = new Map<string, { limited: number; total: number }>();
  const rep = (id: string, cpu: number, none: number) => ({
    id,
    qualityLimitationDurations: { cpu, bandwidth: 0, none, other: 0 },
  });
  check(() => assert.equal(cpuLimitedShare([rep("a", 0, 10)], prev), undefined, "first sample is the baseline"));
  check(() => assert.equal(cpuLimitedShare([rep("a", 1.5, 10.5)], prev), 0.75));
  // Worst sender wins (camera fine, share starved).
  check(() =>
    assert.equal(cpuLimitedShare([rep("a", 1.5, 12.5), rep("b", 0, 0)], prev), 0),
  );
  check(() => assert.equal(cpuLimitedShare([rep("a", 1.5, 14.5), rep("b", 2, 0)], prev), 1));
  // Only an instantaneous reason: all or nothing.
  check(() => assert.equal(cpuLimitedShare([{ id: "c", qualityLimitationReason: "cpu" }], prev), 1));
  check(() => assert.equal(cpuLimitedShare([{ id: "c", qualityLimitationReason: "bandwidth" }], prev), 0));
  check(() => assert.equal(cpuLimitedShare([], prev), undefined));
}

// ---------------------------------------------------------------- CPU policy
console.log("cpu policy");
{
  // The rungs, in order: fps first, then effects, then the codec, and only then a layer.
  check(() => assert.deepEqual([...CPU_STEPS], ["none", "fps", "effects", "codec", "layer"]));
  // Sustained cpu ≥ 50% for 6 s → fps; and recovery takes a 30 s clean window.
  const { moves, state } = replay(ADAPT.cpu, times(4, { cpu: 0.7 }));
  check(() => assert.deepEqual(moves.map((m) => [m.to, m.at]), [[1, 8000]]));
  const back = replay(ADAPT.cpu, times(20, { cpu: 0 }), { start: state });
  check(() => assert.equal(back.moves[0]?.at, 2000 + ADAPT.cpu.cleanMs));
  // 20% cpu-limited is noise: no move, and not clean either (> 5%) — it holds.
  check(() => assert.equal(replay(ADAPT.cpu, times(60, { cpu: 0.2 }), { start: state }).moves.length, 0));

  const ctx = (p: Partial<{ camera: boolean; share: boolean; effects: boolean; cameraAv1: boolean }>) => ({
    camera: true,
    share: false,
    effects: false,
    cameraAv1: false,
    ...p,
  });
  const land = (from: number, to: number, c: ReturnType<typeof ctx>, effectsPaused = false) =>
    cpuLanding(
      from,
      to,
      (s: CpuStep) => cpuStepApplies(s, c),
      (s: CpuStep) => cpuReleaseIsNoop(s, { effectsPaused }),
    );
  const at = (s: CpuStep) => CPU_STEPS.indexOf(s);
  // VP8 camera, blur on: fps → effects → (no codec to drop) layer.
  check(() => assert.equal(land(0, 1, ctx({ effects: true })), at("fps")));
  check(() => assert.equal(land(1, 2, ctx({ effects: true })), at("effects")));
  check(() => assert.equal(land(2, 3, ctx({ effects: true })), at("layer"), "no AV1: codec rung skipped"));
  // AV1 camera, no effects: fps → codec (effects skipped) → layer.
  check(() => assert.equal(land(1, 2, ctx({ cameraAv1: true })), at("codec")));
  check(() => assert.equal(land(3, 4, ctx({ cameraAv1: true })), at("layer")));
  // Share only (no camera): only the fps rungs apply.
  check(() => assert.equal(land(1, 2, ctx({ camera: false, share: true })), at("layer")));
  // Nothing published: nothing to do.
  check(() => assert.equal(land(0, 1, ctx({ camera: false, share: false })), null));
  // On the way up the codec rung is sticky (a no-op to release) and unpaused effects too.
  check(() => assert.equal(land(4, 3, ctx({}), false), at("fps")));
  check(() => assert.equal(land(4, 3, ctx({}), true), at("effects"), "paused effects come back as their own step"));
  check(() => assert.equal(land(2, 1, ctx({}), true), at("fps")));
  // Frame rates per level: cameras cut fps before any layer; shares never lose resolution.
  check(() => assert.deepEqual([...ADAPT.cpu.cameraFps], [30, 20, 20, 20, 15]));
  check(() => assert.ok(ADAPT.cpu.shareFps.sharp.every((f, i, a) => i === 0 || f <= a[i - 1])));
}

// ---------------------------------------------------------------- AV1 rungs: actually cheaper
console.log("av1 bitrates");
{
  const sum = (rungs: { maxBitrate: number }[]) => rungs.reduce((s, r) => s + r.maxBitrate, 0);
  const av1 = cameraLadder("av1");
  for (const tier of ["full", "reduced", "minimal"] as const) {
    check(() => assert.ok(Math.abs(sum(av1[tier]) - sum(LADDER[tier]) * AV1_SAVING) <= 2));
    check(() => assert.ok(sum(av1[tier]) <= sum(LADDER[tier]) * 0.71, `${tier}: AV1 spends ≥ 29% less`));
  }
  check(() => assert.equal(cameraLadder("vp8"), LADDER));
  // No cliff: adjacent active AV1 layers stay within 5x.
  const full = av1.full.map((r) => r.maxBitrate);
  check(() => assert.ok(full[1] / full[0] <= 5 && full[2] / full[1] <= 5));
  for (const mode of ["sharp", "video"] as const) {
    check(() => assert.ok(SHARE_SINGLE_BITRATES.av1[mode] <= SHARE_SINGLE_BITRATES.vp9[mode] * 0.71));
    check(() => assert.ok(SHARE_BITRATES.av1[mode].top <= SHARE_BITRATES.vp9[mode].top * 0.71));
  }
}

// ---------------------------------------------------------------- the live camera encodings
console.log("camera encodings");
{
  const top = CAMERA_1080_BITRATE;
  const vp8 = cameraEncodingPlan("full", "vp8", 3, top);
  check(() => assert.deepEqual(vp8.map((e) => e.maxBitrate), [200_000, 640_000, CAMERA_1080_BITRATE]));
  check(() => assert.deepEqual(vp8.map((e) => e.maxFramerate), [15, 20, 30]));
  const av1 = cameraEncodingPlan("full", "av1", 3, top);
  check(() => assert.deepEqual(av1.map((e) => e.maxBitrate), [140_000, 448_000, Math.round(CAMERA_1080_BITRATE * AV1_SAVING)]));
  // Reduced turns the top layer off; minimal keeps 360p only.
  check(() => assert.deepEqual(cameraEncodingPlan("reduced", "av1", 3, top).map((e) => e.active), [true, true, false]));
  check(() => assert.deepEqual(cameraEncodingPlan("minimal", "vp8", 3, top).map((e) => e.active), [false, true, false]));
  // CPU fps cap: no layer above it, none raised past its own.
  check(() => assert.deepEqual(cameraEncodingPlan("full", "vp8", 3, top, 15).map((e) => e.maxFramerate), [15, 15, 15]));
  check(() => assert.deepEqual(cameraEncodingPlan("full", "vp8", 3, top, 20).map((e) => e.maxFramerate), [15, 20, 20]));
  // A 720p device's top is its own preset, scaled for AV1.
  check(() => assert.equal(
    cameraEncodingPlan("full", "av1", 3, CAMERA_720_BITRATE)[2].maxBitrate,
    Math.round(CAMERA_720_BITRATE * AV1_SAVING),
  ));
  // One encoding (AV1 fallen back to single L1T3): the rung's total as one cap, never off.
  const single = cameraEncodingPlan("reduced", "av1", 1, top);
  check(() => assert.equal(single.length, 1));
  check(() => assert.equal(single[0].active, true));
  check(() => assert.equal(single[0].maxBitrate, 140_000 + 448_000));
}

// ---------------------------------------------------------------- publish options
console.log("publish options");
{
  const av1 = cameraPublishDefaults("av1");
  check(() => assert.equal(av1.videoCodec, "av1"));
  check(() => assert.equal(av1.scalabilityMode, "L1T3", "rid simulcast, three temporal layers"));
  check(() => assert.ok(av1.backupCodec && av1.backupCodec.codec === "vp8", "VP8 backup for Safari / iOS subscribers"));
  const vp8 = cameraPublishDefaults("vp8");
  check(() => assert.deepEqual(vp8, { videoCodec: "vp8", scalabilityMode: undefined, backupCodec: false }));
  check(() => assert.equal(cameraCodecOfTrack("av1"), "av1"));
  check(() => assert.equal(cameraCodecOfTrack("VP8"), "vp8"));
  check(() => assert.equal(cameraCodecOfTrack(undefined), "vp8"));
  check(() => assert.equal(shareCodecOfTrack("av1"), "av1"));

  // An AV1 share is published like the VP9 one (single L1T3, H264 backup at H264's bitrate).
  for (const mode of ["sharp", "video"] as const) {
    const p = shareEncodingPlan(mode, "av1");
    check(() => assert.equal(p.videoCodec, "av1"));
    check(() => assert.equal(p.layout, "single"));
    check(() => assert.equal(p.simulcast, false));
    check(() => assert.equal(p.scalabilityMode, "L1T3"));
    check(() => assert.equal(p.backupCodec, "h264"));
    check(() => assert.equal(p.backupEncoding.maxBitrate, SHARE_SINGLE_BITRATES.h264[mode]));
    check(() => assert.equal(p.screenShareEncoding.maxBitrate, SHARE_SINGLE_BITRATES.av1[mode]));
    check(() => assert.equal(p.degradationPreference, "maintain-resolution", "keep resolution (#639/#641)"));
    check(() => assert.equal(p.encoderHint, "motion"));
    const s = shareEncodingPlan(mode, "av1", false);
    check(() => assert.equal(s.simulcast, true));
    check(() => assert.equal(s.scalabilityMode, "L1T1"));
  }
  // The share ladder on AV1 keeps resolution and only cuts fps / bitrate.
  const ladder = shareLadder("av1", "sharp", "single");
  check(() => assert.deepEqual(ladder.reduced, [{ maxBitrate: Math.round(SHARE_SINGLE_BITRATES.av1.sharp * 0.6), maxFramerate: 8 }]));
}

// ---------------------------------------------------------------- headroom
console.log("headroom");
check(() => assert.equal(headroomOf(0, 1_000_000), undefined));
check(() => assert.equal(headroomOf(1300, 1_000_000), 0.3));
check(() => assert.ok((headroomOf(500, 1_000_000) ?? 0) < 0));

console.log(`\nPASS adapt-governor (${checks} checks)`);
