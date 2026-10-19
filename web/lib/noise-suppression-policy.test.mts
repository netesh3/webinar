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
  LIMIT_KNEE,
  MAKEUP_GAIN,
  SOUND_FLOOR,
  STARVED_CHECKS,
  judgeWorklet,
  softLimitCurve,
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

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
