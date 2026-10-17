import assert from "node:assert/strict";
import {
  AUDIO_RMS,
  MOTION,
  changedFraction,
  initialMotionState,
  lumaGrid,
  nextMotionState,
  rms,
  type MotionSample,
  type MotionState,
} from "./share-motion.ts";

const TICK = 250;

/** Run a sequence of [changed, audio] pairs at TICK ms; returns the mode after each. */
function run(
  seq: Array<[number, boolean?]>,
  start: MotionState = initialMotionState(0),
  tick = TICK,
): { modes: string[]; state: MotionState } {
  let state = start;
  const t0 = start.samples.at(-1)?.t ?? 0;
  const modes: string[] = [];
  seq.forEach(([changed, audio], i) => {
    const s: MotionSample = { t: t0 + (i + 1) * tick, changed, audio: audio ?? false };
    state = nextMotionState(state, s);
    modes.push(state.mode);
  });
  return { modes, state };
}
const repeat = <T,>(v: T, n: number): T[] => Array.from({ length: n }, () => v);
const seconds = (s: number, tick = TICK) => Math.round((s * 1000) / tick);

// A static deck: nothing moves, never video.
{
  const { modes } = run(repeat<[number]>([0], seconds(30)));
  assert.ok(modes.every((m) => m === "sharp"), "static deck stays sharp");
}

// Typing / cursor: a few cells (well under 1%) change every sample.
{
  const { modes } = run(repeat<[number]>([0.004], seconds(30)));
  assert.ok(modes.every((m) => m === "sharp"), "typing and a moving cursor stay sharp");
}

// Slide transitions: one full-frame change every 10 s, quiet between.
{
  const seq: Array<[number]> = [];
  for (let slide = 0; slide < 6; slide++) {
    seq.push([1]);
    seq.push(...repeat<[number]>([0], seconds(10) - 1));
  }
  const { modes } = run(seq);
  assert.ok(modes.every((m) => m === "sharp"), "slide transitions stay sharp");
}

// A short scroll through code (1 s of heavy change) between reading pauses.
{
  const seq: Array<[number]> = [];
  for (let i = 0; i < 6; i++) {
    seq.push(...repeat<[number]>([0.7], seconds(1)));
    seq.push(...repeat<[number]>([0.002], seconds(4)));
  }
  const { modes } = run(seq);
  assert.ok(modes.every((m) => m === "sharp"), "scrolling a code editor stays sharp");
}

// Full-screen YouTube: most of the frame changes every sample → video within ~2 s.
{
  const { modes } = run(repeat<[number]>([0.6], seconds(10)));
  const first = modes.indexOf("video");
  assert.ok(first >= 0, "full-screen video switches to video");
  assert.ok((first + 1) * TICK <= 2_250, `switches within ~2 s (took ${(first + 1) * TICK} ms)`);
  assert.ok(modes.slice(first).every((m) => m === "video"), "and holds it while playing");
}

// A small player (640×360 on a 1080p screen ≈ 11% of the frame) is still a video.
{
  const { modes } = run(repeat<[number]>([0.11], seconds(10)));
  assert.equal(modes.at(-1), "video", "an embedded player switches to video");
}

// Video with an occasional static shot (20% of samples quiet) keeps video.
{
  const seq: Array<[number]> = [];
  for (let i = 0; i < seconds(20); i++) seq.push([i % 5 === 0 ? 0 : 0.4]);
  const { modes } = run(seq);
  const first = modes.indexOf("video");
  assert.ok(first >= 0, "mostly-moving video switches");
  assert.ok(modes.slice(first).every((m) => m === "video"), "a few still frames do not flap");
}

// Paused video: back to sharp after ~5 s of stillness, not sooner.
{
  const playing = run(repeat<[number]>([0.6], seconds(6)));
  assert.equal(playing.state.mode, "video");
  const paused = run(repeat<[number]>([0], seconds(8)), playing.state);
  const back = paused.modes.indexOf("sharp");
  assert.ok(back >= 0, "a paused video goes back to sharp");
  const ms = (back + 1) * TICK;
  assert.ok(ms >= MOTION.settle - 1_000 && ms <= MOTION.settle + 500, `settles after ~5 s (took ${ms} ms)`);
}

// Audio only (a talk played over a still image): video after ~1.5 s of sound.
{
  const { modes } = run(repeat<[number, boolean]>([0, true], seconds(6)));
  const first = modes.indexOf("video");
  assert.ok(first >= 0, "continuous share audio switches to video");
  assert.ok((first + 1) * TICK >= MOTION.audioFor, "not before audioFor");
  assert.ok((first + 1) * TICK <= MOTION.audioFor + TICK * 2, "promptly after audioFor");
}

// A notification sound (under a second) does not.
{
  const seq: Array<[number, boolean]> = [
    ...repeat<[number, boolean]>([0, true], 3),
    ...repeat<[number, boolean]>([0, false], seconds(10)),
  ];
  const { modes } = run(seq);
  assert.ok(modes.every((m) => m === "sharp"), "a short sound stays sharp");
}

// Audio keeps video on even when the picture stops (a still frame with music).
{
  const playing = run(repeat<[number, boolean]>([0.6, true], seconds(4)));
  const still = run(repeat<[number, boolean]>([0, true], seconds(10)), playing.state);
  assert.ok(still.modes.every((m) => m === "video"), "share audio holds video");
}

// A throttled sampler (one tick a second, a background tab) still decides.
{
  const { modes } = run(repeat<[number]>([0.6], 6), initialMotionState(0), 1_000);
  assert.equal(modes.at(-1), "video", "1 Hz sampling still detects video");
  const quiet = run(repeat<[number]>([0], 10), initialMotionState(0), 1_000);
  assert.ok(quiet.modes.every((m) => m === "sharp"), "1 Hz static stays sharp");
}

// A long gap then one sample is not enough history to call it.
{
  let s = initialMotionState(0);
  s = nextMotionState(s, { t: 10_000, changed: 1, audio: false });
  s = nextMotionState(s, { t: 10_250, changed: 1, audio: false });
  assert.equal(s.mode, "sharp", "two samples are not a window");
}

// The state is not mutated in place.
{
  const s0 = initialMotionState(0);
  nextMotionState(s0, { t: 250, changed: 1, audio: true });
  assert.equal(s0.samples.length, 0);
  assert.equal(s0.audioSince, null);
}

// Samples older than the longest rule are dropped (bounded memory).
{
  const { state } = run(repeat<[number]>([0], seconds(60)));
  assert.ok(state.samples.length <= seconds(5) + 1, `history is bounded (${state.samples.length})`);
}

// changedFraction: identical, threshold noise, and real change.
{
  const a = new Uint8Array([10, 10, 10, 10]);
  assert.equal(changedFraction(null, a), 0, "first frame");
  assert.equal(changedFraction(a, new Uint8Array([10, 10, 10, 10])), 0);
  assert.equal(changedFraction(a, new Uint8Array([14, 6, 18, 10])), 0, "jitter under threshold");
  assert.equal(changedFraction(a, new Uint8Array([200, 10, 10, 10])), 0.25);
  assert.equal(changedFraction(a, new Uint8Array([10, 10])), 0, "size mismatch");
}

// lumaGrid: white, black, pure green brighter than pure blue.
{
  const g = lumaGrid([255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  assert.equal(g.length, 4);
  assert.ok(g[0] >= 254 && g[1] === 0, "white and black");
  assert.ok(g[2] > g[3], "green reads brighter than blue");
  const out = new Uint8Array(4);
  assert.equal(lumaGrid([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], out), out, "reuses the buffer");
}

// rms: silence, a full-scale square wave, a quiet hiss under the threshold.
{
  assert.equal(rms([]), 0);
  assert.equal(rms([0, 0, 0]), 0);
  assert.equal(rms([1, -1, 1, -1]), 1);
  assert.ok(rms([0.002, -0.003, 0.002]) < AUDIO_RMS, "hiss is not audio");
  assert.ok(rms([0.2, -0.2, 0.2]) > AUDIO_RMS, "a voice is");
}

console.log("PASS share-motion");
