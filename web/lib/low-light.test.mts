/* Tests for the low-light preference.
 *
 * Run with `make test-web`. The CURVE is not tested here — it is GLSL, and a JavaScript
 * reimplementation of it would assert its properties without proving any of them. That is
 * e2e/probe-low-light.mjs, which compiles the shipped shader on a real GPU.
 *
 * What is here is the value on its way in from storage, which is where the interesting
 * failures are. This number reaches the shader as a gamma exponent: the shader divides by
 * `1 + amount * LIFT`, so a negative amount below -1 flips the sign and inverts the picture,
 * and a large one flattens the frame towards white. Preferences are persisted as JSON and
 * read back with a spread, so the value can be a string from an older build, a NaN from a
 * failed write, or anything at all from a hand-edited localStorage — and a presenter looking
 * at an inverted camera has nothing in the UI that would explain it.
 */

import { asLowLight, describeLowLight, LOW_LIGHT_MAX, LOW_LIGHT_STEP } from "./backgrounds.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

console.log("\nthe slider's range");

{
  ok(LOW_LIGHT_MAX > 0, "there is a top to the slider");
  ok(
    LOW_LIGHT_MAX % LOW_LIGHT_STEP === 0,
    "the step divides the range, so the top of the slider is reachable",
    `${LOW_LIGHT_MAX} % ${LOW_LIGHT_STEP} = ${LOW_LIGHT_MAX % LOW_LIGHT_STEP}`,
  );
}

console.log("\nasLowLight");

{
  eq(asLowLight(0), 0, "off stays off");
  eq(asLowLight(40), 40, "a value in range is kept");
  eq(asLowLight(LOW_LIGHT_MAX), LOW_LIGHT_MAX, "the top of the range is kept");

  // The two that invert or wash out the picture if they reach the shader.
  eq(asLowLight(-1), 0, "a negative amount clamps to off, not to a sign flip");
  eq(asLowLight(-9999), 0, "a large negative clamps to off");
  eq(asLowLight(5000), LOW_LIGHT_MAX, "a value past the top clamps to the top");

  // Whatever JSON.parse or a hand edit can produce.
  eq(asLowLight(undefined), 0, "a missing preference is off");
  eq(asLowLight(null), 0, "null is off");
  eq(asLowLight(NaN), 0, "NaN is off rather than a NaN gamma");
  /* The rule, and it is worth stating because these two look inconsistent: a FINITE number
   * out of range is a value that needs clamping — 5000 is plausibly a hand edit meaning "as
   * much as you can" — while a non-finite one is not a value at all and falls back to the
   * default, which is off. Corrupt storage turning the brightness to maximum is the worse of
   * the two failures, and it is the one somebody would notice mid-webinar. */
  eq(asLowLight(Infinity), 0, "Infinity is not a value, so it is off rather than the top");
  eq(asLowLight(-Infinity), 0, "and neither is negative Infinity");
  eq(asLowLight("not a number"), 0, "a non-numeric string is off");
  eq(asLowLight({}), 0, "an object is off");
  eq(asLowLight([]), 0, "an empty array is off, not the 0 that Number([]) gives by accident");

  // A string IS what an older build or a range input can leave behind, and it is a real
  // value rather than junk, so it is read rather than discarded.
  eq(asLowLight("45"), 45, "a numeric string is read");

  eq(asLowLight(40.4), 40, "a fraction rounds, so the stored value matches a slider step");
  eq(asLowLight(40.6), 41, "and rounds up when it should");

  // Whatever comes out is a legal input to the shader, for every input at all.
  for (const weird of [-5, 0, 3.7, 99.99, 1e9, -1e9, NaN, "12", "", null, undefined, {}]) {
    const got = asLowLight(weird);
    ok(
      Number.isInteger(got) && got >= 0 && got <= LOW_LIGHT_MAX,
      `asLowLight(${JSON.stringify(weird)}) is a whole number in range`,
      `got ${got}`,
    );
  }
}

console.log("\ndescribeLowLight");

{
  eq(describeLowLight(0), "Off", "zero reads as Off rather than 0%");
  eq(describeLowLight(40), "40%", "a value reads as a percentage");
  // The readout is what somebody uses to find the same amount again next week, so it must
  // describe the value that was actually stored rather than the one that was asked for.
  eq(describeLowLight(-3), "Off", "an out-of-range value describes what was kept");
  eq(describeLowLight(9999), `${LOW_LIGHT_MAX}%`, "and so does one past the top");
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
