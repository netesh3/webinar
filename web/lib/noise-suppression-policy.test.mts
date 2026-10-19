/* Tests for the two judgements inside enhanced noise suppression.
 *
 * Run with `make test-web`. Both decide what an audience hears from a presenter, in the
 * one place nobody can hear it go wrong: the presenter's own browser.
 *
 * The limiter curve must leave ordinary speech exactly as loud as the 1.5× it replaces —
 * a quieter presenter is the complaint the makeup gain was added for — while keeping the
 * loudest syllables under full scale, where the WebRTC sender used to clip them.
 *
 * The watchdog must not give up on a worklet that is merely still loading, or on one
 * listening to a quiet room; and it must give up on one that is silent while somebody is
 * plainly talking into it, because until it does the audience hears nothing at all.
 */

import {
  INITIAL_HEALTH,
  INITIAL_LEVEL,
  LEVEL_MAX_GAIN,
  LEVEL_RISE_DB_PER_S,
  LEVEL_TARGET_DB,
  LEVEL_WARMUP_MS,
  LIMIT_CEILING,
  LIMIT_HEADROOM,
  LIMIT_KNEE,
  MAKEUP_GAIN,
  SOUND_FLOOR,
  SPEECH_GATE_DB,
  STARVED_CHECKS,
  judgeWorklet,
  nextLevel,
  rmsDb,
  softLimitCurve,
  type LevelState,
  type WorkletHealth,
} from "./noise-suppression-policy.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function near(actual: number, expected: number, what: string, tolerance = 1e-6): void {
  ok(
    Math.abs(actual - expected) <= tolerance,
    what,
    `got ${actual}, want ${expected} ± ${tolerance}`,
  );
}

// ---------------------------------------------------------------- the limiter curve

{
  const curve = softLimitCurve();
  const n = curve.length;
  const inputAt = (i: number) => (i / (n - 1)) * 2 - 1;

  ok(n === 2049, "the curve has an odd number of points, so one sits exactly on zero");
  near(curve[(n - 1) / 2], 0, "silence stays silence");

  let symmetric = true;
  let monotonic = true;
  let underFullScale = true;
  let exactBelowKnee = true;
  let largestStep = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(curve[i] + curve[n - 1 - i]) > 1e-6) symmetric = false;
    if (i > 0 && curve[i] < curve[i - 1]) monotonic = false;
    if (Math.abs(curve[i]) >= 1) underFullScale = false;
    if (i > 0) largestStep = Math.max(largestStep, Math.abs(curve[i] - curve[i - 1]));
    const x = inputAt(i);
    if (Math.abs(x) * MAKEUP_GAIN <= LIMIT_KNEE && Math.abs(curve[i] - x * MAKEUP_GAIN) > 1e-6) {
      exactBelowKnee = false;
    }
  }
  ok(symmetric, "a negative sample comes out as the mirror of a positive one");
  ok(monotonic, "louder in is never quieter out");
  ok(underFullScale, "nothing reaches full scale, so nothing is clipped on the way to 16-bit");
  ok(exactBelowKnee, "ordinary speech gets exactly the 1.5× it always had");
  // Steps between neighbours stay about the size of the linear part's: no corner at the
  // knee, where a hard limiter would put one.
  const linearStep = (2 / (n - 1)) * MAKEUP_GAIN;
  ok(largestStep <= linearStep + 1e-6, "no jump anywhere, the knee included", `largest ${largestStep}`);

  // A peak that a plain 1.5× would have clipped: 0.9 in, 1.35 asked for.
  const loud = curve[Math.round(((0.9 + 1) / 2) * (n - 1))];
  ok(loud > LIMIT_KNEE && loud < 1, "a loud peak is pulled in under full scale", `got ${loud}`);
  // The very top of the range still has some room left above the knee rather than
  // flattening into a wall.
  ok(curve[n - 1] > 0.99 && curve[n - 1] < 1, "full scale in maps to just under full scale out");

  const gentle = softLimitCurve(1, 0.8, 9);
  ok(gentle.length === 9, "the point count is honoured");
  near(gentle[8], 0.8 + 0.2 * Math.tanh(1), "the roll-off is tanh above the knee", 1e-6);
}

// ---------------------------------------------------------------- the watchdog

function run(samples: Array<[number, number]>): WorkletHealth {
  return samples.reduce((h, [input, output]) => judgeWorklet(h, input, output), INITIAL_HEALTH);
}

const talking = SOUND_FLOOR * 10;
const quiet = SOUND_FLOOR / 10;

{
  const h = run([
    [quiet, 0],
    [quiet, 0],
    [quiet, 0],
  ]);
  ok(h.verdict === "pending" && h.starved === 0, "a quiet room proves nothing either way");
}

{
  const h = run([[talking, 0.003]]);
  ok(h.verdict === "healthy", "any sound out settles it at once");
}

{
  const h = run([[quiet, 1e-4]]);
  ok(h.verdict === "healthy", "output with only a quiet input is still output");
}

{
  const almost = run(Array.from({ length: STARVED_CHECKS - 1 }, () => [talking, 0] as [number, number]));
  ok(almost.verdict === "pending", "still loading is not failure", `starved ${almost.starved}`);
  const failed = judgeWorklet(almost, talking, 0);
  ok(failed.verdict === "failed", "silent while somebody keeps talking is failure");
}

{
  const samples: Array<[number, number]> = [];
  for (let i = 0; i < STARVED_CHECKS - 1; i++) {
    samples.push([talking, 0], [quiet, 0]);
  }
  const h = run(samples);
  ok(
    h.verdict === "pending" && h.starved === STARVED_CHECKS - 1,
    "pauses between words neither count against it nor reset the count",
    `got ${JSON.stringify(h)}`,
  );
}

{
  const failed = run(Array.from({ length: STARVED_CHECKS }, () => [talking, 0] as [number, number]));
  ok(judgeWorklet(failed, talking, 0.5).verdict === "failed", "failed is final");
  const healthy = run([[talking, 0.5]]);
  ok(judgeWorklet(healthy, talking, 0).verdict === "healthy", "healthy is final");
}

{
  const h = run([[talking, 1e-9]]);
  ok(h.verdict === "pending" && h.starved === 1, "denormal noise out counts as nothing out");
}

// ---------------------------------------------------------------- the limiter at headroom

{
  // How the processor runs it: the leveller's gain divided by LIMIT_HEADROOM going in, the
  // curve multiplying it back. Same gain on ordinary speech, soft over the whole range the
  // leveller can reach.
  const curve = softLimitCurve(LIMIT_HEADROOM);
  const n = curve.length;
  const through = (signal: number, gain: number) => {
    const x = Math.max(-1, Math.min(1, (signal * gain) / LIMIT_HEADROOM));
    const pos = ((x + 1) / 2) * (n - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    return i >= n - 1 ? curve[n - 1] : curve[i] * (1 - f) + curve[i + 1] * f;
  };
  near(through(0.2, MAKEUP_GAIN), 0.3, "at the old 1.5×, ordinary speech is exactly 1.5× louder", 1e-4);
  near(through(0.1, LEVEL_MAX_GAIN), 0.4, "at the most the leveller adds, quiet speech is exactly 4×", 1e-4);
  const shout = through(0.9, LEVEL_MAX_GAIN);
  ok(shout > LIMIT_KNEE && shout <= LIMIT_CEILING, "a shout at 4× is rolled off, not clipped", `got ${shout}`);
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(curve[i]));
  ok(max <= LIMIT_CEILING && max < 1, "never full scale, however far over", `max ${max}`);
}

// ---------------------------------------------------------------- the leveller

near(rmsDb(new Float32Array(256).fill(0.1)), -20, "rmsDb of a steady 0.1 is −20 dBFS", 1e-6);
ok(rmsDb(new Float32Array(256)) < -150, "silence is very quiet, not -Infinity");

/** Feeds the leveller `seconds` of one level, in 100 ms updates. */
function level(state: LevelState, db: number, seconds: number): LevelState {
  let s = state;
  for (let t = 0; t < seconds * 1000; t += 100) s = nextLevel(s, db, 100);
  return s;
}
const dbOf = (gain: number) => 20 * Math.log10(gain);

{
  const s = level(INITIAL_LEVEL, -80, 60);
  near(s.gain, MAKEUP_GAIN, "a silent minute leaves the gain where it was");
  ok(s.levelDb === null, "and nothing has been heard");
}

{
  const s = level(INITIAL_LEVEL, -45, (LEVEL_WARMUP_MS - 200) / 1000);
  near(s.gain, MAKEUP_GAIN, "no adjustment before LEVEL_WARMUP_MS of speech");
}

{
  // Speech at -45 dBFS after RNNoise: 25 dB short of the target, so it wants more than the
  // most the leveller will give.
  const s = level(INITIAL_LEVEL, -45, 20);
  near(s.gain, LEVEL_MAX_GAIN, "a quiet speaker is brought up to the most it allows", 1e-6);
}

{
  const after = level(INITIAL_LEVEL, -45, LEVEL_WARMUP_MS / 1000 + 1);
  const risen = dbOf(after.gain) - dbOf(MAKEUP_GAIN);
  ok(risen <= LEVEL_RISE_DB_PER_S + 0.31, "and it gets there slowly, not in a jump", `rose ${risen} dB in 1 s`);
}

{
  // A speaker already at the target needs only a little — less than the old 1.5× — and
  // keeps the 1.5× they had.
  const s = level(INITIAL_LEVEL, LEVEL_TARGET_DB - 1, 20);
  near(s.gain, MAKEUP_GAIN, "a speaker who was fine is left exactly as they were");
  const loud = level(INITIAL_LEVEL, -10, 20);
  near(loud.gain, MAKEUP_GAIN, "a loud one is never turned below the old boost");
}

{
  // Halfway: wants LEVEL_TARGET_DB - (-30) = 10 dB.
  const s = level(INITIAL_LEVEL, -30, 20);
  near(dbOf(s.gain), 10, "in between, the gain is what brings them to the target", 0.05);
}

{
  // Brought up, then a long pause: the gain holds through it.
  const up = level(INITIAL_LEVEL, -45, 20);
  const paused = level(up, -75, 30);
  near(paused.gain, up.gain, "a pause does not move the gain, so the silence is not turned up");
}

{
  // Brought up, then they lean in and shout: it comes back down, faster than it went up.
  const up = level(INITIAL_LEVEL, -45, 20);
  const down = level(up, -8, 1);
  const fell = dbOf(up.gain) - dbOf(down.gain);
  ok(fell > LEVEL_RISE_DB_PER_S, "a sudden loud speaker is caught quickly", `fell ${fell} dB in 1 s`);
  const settled = level(down, -8, 10);
  near(settled.gain, MAKEUP_GAIN, "and settles back at the floor");
}

{
  // A cough in a quiet room: one loud moment, then silence. Nowhere near the warm-up.
  let s = nextLevel(INITIAL_LEVEL, -12, 100);
  s = level(s, -80, 10);
  near(s.gain, MAKEUP_GAIN, "a single cough is not a verdict on anybody's voice");
}

{
  ok(nextLevel(INITIAL_LEVEL, SPEECH_GATE_DB, 100) === INITIAL_LEVEL, "exactly at the gate is not speech");
  ok(nextLevel(INITIAL_LEVEL, -30, 0) === INITIAL_LEVEL, "no time passed, nothing changes");
  ok(nextLevel(INITIAL_LEVEL, Number.NaN, 100) === INITIAL_LEVEL, "a NaN reading changes nothing");
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
