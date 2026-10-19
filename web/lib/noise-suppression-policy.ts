/* The judgements inside enhanced noise suppression that can be checked without a browser.
 *
 * lib/noise-suppression.ts is Web Audio and LiveKit throughout, and Node has neither. The
 * two decisions it makes that are worth pinning down — how loud RNNoise's output is made
 * without clipping it, and whether the worklet is producing any sound at all — live here
 * instead, with no imports, so lib/noise-suppression-policy.test.mts can load them. The
 * same split as lib/republish.ts.
 */

/** RNNoise is not level-preserving. See the makeup-gain note in lib/noise-suppression.ts. */
export const MAKEUP_GAIN = 1.5;

/** The output level (0..1) where the limiter starts to bend. Below it the curve is exactly
 *  MAKEUP_GAIN × input, so ordinary speech comes out as loud as it always has. */
export const LIMIT_KNEE = 0.8;

/**
 * The WaveShaper curve that applies MAKEUP_GAIN and keeps the result under full scale.
 *
 * The gain used to be a plain GainNode, and 1.5 × a loud syllable is past 1.0 — which the
 * WebRTC sender then hard-clips when it converts to 16-bit, as a crackle on exactly the
 * words someone said loudest. This is the same 1.5 wherever speech normally sits, and above
 * LIMIT_KNEE a tanh roll-off (matched in slope at the knee, so there is no corner to hear)
 * that approaches full scale without reaching it.
 *
 * A WaveShaper rather than a DynamicsCompressorNode: the compressor applies an automatic
 * makeup gain of its own, which would raise everything, quiet speech and the residual
 * noise under it included — not just the peaks.
 */
export function softLimitCurve(
  gain = MAKEUP_GAIN,
  knee = LIMIT_KNEE,
  points = 2049,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const headroom = 1 - knee;
  for (let i = 0; i < points; i++) {
    // A WaveShaper reads its curve as the output for inputs spread evenly over -1..1.
    const x = (i / (points - 1)) * 2 - 1;
    const t = Math.abs(x) * gain;
    const y = t <= knee ? t : knee + headroom * Math.tanh((t - knee) / headroom);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/** A peak at the microphone that counts as somebody making a sound: about −40 dBFS. */
export const SOUND_FLOOR = 0.01;

/** Below this the worklet's output is taken to be nothing at all. RNNoise attenuates; it
 *  does not turn a signal this loud into exact zeros. Exact zeros mean nothing ran. */
export const SILENT_OUTPUT = 1e-7;

/** Checks with sound going in and nothing coming out before the worklet is judged not to be
 *  running. At the 500 ms check interval this is three seconds of the person talking: more
 *  than the worklet takes to compile its WebAssembly, during which it is silent by design. */
export const STARVED_CHECKS = 6;

export type WorkletHealth = {
  verdict: "pending" | "healthy" | "failed";
  /** Checks so far that had sound in and nothing out. */
  starved: number;
};

export const INITIAL_HEALTH: WorkletHealth = { verdict: "pending", starved: 0 };

/**
 * One look at the worklet: the loudest sample going in, and the loudest coming out.
 *
 * The worklet never says it failed. It loads its WebAssembly in a promise nobody awaits,
 * and until that resolves — or forever, if it rejects — it writes nothing to its output.
 * Silence out is only evidence when there was sound in, so a quiet room is never counted
 * against it, and any sound out at all settles it the other way for good.
 */
export function judgeWorklet(
  prev: WorkletHealth,
  inputPeak: number,
  outputPeak: number,
): WorkletHealth {
  if (prev.verdict !== "pending") return prev;
  if (outputPeak > SILENT_OUTPUT) return { verdict: "healthy", starved: prev.starved };
  if (inputPeak < SOUND_FLOOR) return prev;
  const starved = prev.starved + 1;
  return { verdict: starved >= STARVED_CHECKS ? "failed" : "pending", starved };
}
