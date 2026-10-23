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
  near(through(0.05, LEVEL_MAX_GAIN), 0.05 * LEVEL_MAX_GAIN, `at the most the leveller adds, quiet speech is exactly ${LEVEL_MAX_GAIN}×`, 1e-4);
  const shout = through(0.9, LEVEL_MAX_GAIN);
  ok(shout > LIMIT_KNEE && shout <= LIMIT_CEILING, `a shout at ${LEVEL_MAX_GAIN}× is rolled off, not clipped`, `got ${shout}`);
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(curve[i]));
  ok(max <= LIMIT_CEILING && max < 1, "never full scale, however far over", `max ${max}`);
}

// ---------------------------------------------------------------- the leveller

near(rmsDb(new Float32Array(256).fill(0.1)), -20, "rmsDb of a steady 0.1 is −20 dBFS", 1e-6);
ok(rmsDb(new Float32Array(256)) < -150, "silence is very quiet, not -Infinity");

const dbOf = (gain: number) => 20 * Math.log10(gain);
const FLOOR_DB = dbOf(MAKEUP_GAIN);
const MAX_DB = dbOf(LEVEL_MAX_GAIN);

/* Speech as the leveller sees it: 100 ms readings of RNNoise's output around a mean, with
 * the shape of talking — syllables, dips between them, and a short gap every so often —
 * rather than a steady tone, which no test of a level control should be fooled by. */
const SHAPE = [0, -2, -5, -1, -8, -3, 0, -12, -4, -1, -30, -2, -6, 0, -3, -9];
function speech(meanDb: number, seconds: number, phase = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < seconds * 10; i++) out.push(meanDb + 3 + SHAPE[(i + phase) % SHAPE.length]);
  return out;
}
const steady = (db: number, seconds: number) => Array.from({ length: seconds * 10 }, () => db);

/** Runs readings through the leveller, returning the state and the gain (dB) after each. */
function drive(readings: number[], start: LevelState = INITIAL_LEVEL) {
  let s = start;
  const gains: number[] = [];
  for (const r of readings) {
    s = nextLevel(s, r, 100);
    gains.push(dbOf(s.gain));
  }
  return { state: s, gains };
}

{
  const { state } = drive(steady(-80, 60));
  near(state.gain, MAKEUP_GAIN, "a silent minute leaves the gain where it was");
  ok(state.levelDb === null, "and nothing has been learned");
}

{
  const { state } = drive(speech(-40, (LEVEL_WARMUP_MS - 200) / 1000));
  near(state.gain, MAKEUP_GAIN, "no adjustment before LEVEL_WARMUP_MS of speech");
}

{
  const { state, gains } = drive(speech(-40, 20));
  ok(dbOf(state.gain) > MAX_DB - 0.5, "a quiet speaker is brought up to the most it allows", `got ${dbOf(state.gain)}`);
  const risen = gains[(LEVEL_WARMUP_MS + 1000) / 100] - FLOOR_DB;
  ok(risen <= LEVEL_RISE_DB_PER_S + 0.31, "and slowly, not in a jump", `rose ${risen} dB in its first second`);
}

{
  const { state } = drive(speech(LEVEL_TARGET_DB - 1, 30));
  ok(Math.abs(dbOf(state.gain) - FLOOR_DB) < 0.05, "a speaker who was fine is left exactly as they were", `got ${dbOf(state.gain)}`);
  const loud = drive(speech(-10, 30)).state;
  near(loud.gain, MAKEUP_GAIN, "a loud one is never turned below the old boost");
}

{
  // A steady talker does not have their gain wander under them.
  // At -28 dBFS they need LEVEL_TARGET_DB + 28 dB to reach the target: between the floor and
  // the ceiling, so the gain is the leveller's own judgement rather than a limit.
  const { gains } = drive(speech(-28, 40));
  const settled = gains.slice(200);
  const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
  const sd = Math.sqrt(settled.reduce((a, b) => a + (b - mean) ** 2, 0) / settled.length);
  ok(sd < 0.5, "a steady talker's gain holds steady", `standard deviation ${sd.toFixed(2)} dB`);
  const need = LEVEL_TARGET_DB + 28;
  ok(need > FLOOR_DB && need < MAX_DB, "(the case is between the floor and the ceiling)");
  ok(Math.abs(mean - need) < 2, "at about what brings them to the target", `mean ${mean.toFixed(1)} dB`);
}

{
  // A loud first word does not decide who they are.
  const { state } = drive([-12, -12, ...speech(-38, 20)]);
  ok(dbOf(state.gain) > MAX_DB - 1, "one loud first word is outvoted by the rest", `got ${dbOf(state.gain)}`);
}

{
  // The host talks normally, then listens while a voice across the room or a television
  // carries on. The reviewer's case: this used to ramp to the leveller's maximum.
  const host = drive(speech(-24, 10)).state;
  for (const [what, level] of [["a voice across the room", -46], ["residual echo", -48]] as const) {
    const { state } = drive(steady(level, 40), host);
    ok(dbOf(state.gain) < FLOOR_DB + 0.5, `${what} while the host listens does not turn them up`, `got ${dbOf(state.gain).toFixed(1)} dB`);
  }
  const typing: number[] = [];
  for (let i = 0; i < 150; i++) typing.push(i % 3 === 0 ? -35 : -80);
  const typed = drive(typing, host).state;
  ok(dbOf(typed.gain) < FLOOR_DB + 1, "nor does typing", `got ${dbOf(typed.gain).toFixed(1)} dB`);
}

{
  // A quiet host in a room with a steady background: boosted, but the room is not.
  const { state } = drive([...speech(-40, 15), ...steady(-52, 10), ...speech(-40, 15)]);
  ok(dbOf(state.gain) <= -45 - -52 + 0.01, "the room is not turned up past PAUSE_CEILING_DB", `got ${dbOf(state.gain).toFixed(1)} dB`);
}

{
  // Somebody louder takes the microphone after a quiet speaker. The reviewer's case: their
  // first words came out 8 dB hot for over a second.
  const quiet = drive(speech(-40, 20)).state;
  const { gains } = drive(speech(-18, 10), quiet);
  const louder = speech(-18, 10);
  const out = gains.map((g, i) => louder[i] + g);
  const overAfterHalfSecond = Math.max(...out.slice(5, 30)) - LEVEL_TARGET_DB;
  ok(overAfterHalfSecond < 9, "a louder voice is pulled in within half a second", `${overAfterHalfSecond.toFixed(1)} dB over`);
  ok(gains[gains.length - 1] < FLOOR_DB + 0.5, "and settles at the floor", `got ${gains[gains.length - 1].toFixed(1)} dB`);
}

{
  // A one-second laugh in the middle of quiet speech: a dip, then back.
  const before = drive(speech(-40, 20)).state;
  const { gains } = drive([...steady(-20, 1), ...speech(-40, 8)], before);
  const lowest = Math.min(...gains);
  const after = gains[gains.length - 1];
  ok(after > MAX_DB - 1, "a laugh does not leave a quiet speaker turned down", `ended at ${after.toFixed(1)} dB`);
  ok(MAX_DB - lowest < 12, "and the dip is the laugh, not a collapse", `dipped to ${lowest.toFixed(1)} dB`);
}

{
  // A cough in a quiet room before anything is learned.
  const { state } = drive([-12, ...steady(-80, 10)]);
  near(state.gain, MAKEUP_GAIN, "a single cough is not a verdict on anybody's voice");
}

{
  const atGate = nextLevel(INITIAL_LEVEL, SPEECH_GATE_DB, 100);
  ok(atGate.gain === MAKEUP_GAIN && atGate.speechMs === 0, "exactly at the gate is not speech");
  ok(nextLevel(INITIAL_LEVEL, -30, 0) === INITIAL_LEVEL, "no time passed, nothing changes");
  ok(nextLevel(INITIAL_LEVEL, Number.NaN, 100) === INITIAL_LEVEL, "a NaN reading changes nothing");
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
