/* The judgements inside enhanced noise suppression that can be checked without a browser.
 *
 * lib/noise-suppression.ts is Web Audio and LiveKit throughout, and Node has neither. The
 * decisions it makes that are worth pinning down — how loud RNNoise's output is made
 * without clipping it, how far a quiet speaker is brought up, and whether the worklet is
 * producing any sound at all — live here instead, with no imports, so
 * lib/noise-suppression-policy.test.mts can load them. The same split as lib/republish.ts.
 */

/** RNNoise is not level-preserving. See the makeup-gain note in lib/noise-suppression.ts.
 *  The fixed boost everyone got before the leveller below, and still the least anyone gets. */
export const MAKEUP_GAIN = 1.5;

/** The output level (0..1) where the limiter starts to bend. Below it the curve is exactly
 *  `gain` × input, so ordinary speech comes out exactly as loud as the gain says. */
export const LIMIT_KNEE = 0.8;

/** The most the curve ever outputs, just under full scale: the roll-off approaches 1.0 so
 *  closely for a big over that float32 would otherwise round it to exactly 1.0. */
export const LIMIT_CEILING = 0.9999;

/**
 * The WaveShaper curve that applies `gain` and keeps the result under full scale.
 *
 * The gain used to be a plain GainNode, and 1.5 × a loud syllable is past 1.0 — which the
 * WebRTC sender then hard-clips when it converts to 16-bit, as a crackle on exactly the
 * words someone said loudest. This is exactly `gain` wherever speech normally sits, and
 * above LIMIT_KNEE a tanh roll-off (matched in slope at the knee, so there is no corner to
 * hear) that approaches full scale without reaching it. The processor runs it at gain 1, as
 * the limiter after the leveller, which does the boosting.
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
    curve[i] = Math.sign(x) * Math.min(y, LIMIT_CEILING);
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

/* ------------------------------------------------------------------ the leveller
 *
 * "The host's voice is very low," from a webinar where it was not everyone's: a fixed 1.5×
 * after RNNoise is right for somebody close to a good microphone and not enough for
 * somebody further from a laptop's. RNNoise attenuates by how sure it is that a band is
 * speech, and a quiet capture is a low-SNR capture, so it is exactly the quiet speaker
 * who loses the most to it. So the gain after RNNoise follows the speaker:
 *
 *   - It measures their speech, after RNNoise and before the gain, and aims it at
 *     LEVEL_TARGET_DB.
 *   - It never goes below MAKEUP_GAIN, so nobody comes out quieter than the fixed boost
 *     gave them; a speaker who was fine is left exactly as they were.
 *   - It never goes above LEVEL_MAX_GAIN, and the limiter after it (softLimitCurve) keeps
 *     whatever it does under full scale.
 *   - It only moves while somebody is talking. In a pause it holds, so the room's residual
 *     noise is not turned up into the silence — the pumping a naive AGC is known for.
 *   - It moves slowly (LEVEL_RISE_DB_PER_S up, LEVEL_FALL_DB_PER_S down — down faster, so a
 *     shout after a whisper is caught quickly) and waits LEVEL_WARMUP_MS of speech before
 *     moving at all, so a cough is not a verdict on somebody's voice. */

/** Speech RMS after the gain, in dBFS, that the leveller aims for. Comfortably conversational
 *  for a WebRTC speech track; a speaker whose RNNoise output already sits above
 *  LEVEL_TARGET_DB − 3.5 dB needs no more than MAKEUP_GAIN and is not touched. */
export const LEVEL_TARGET_DB = -20;

/** The most the leveller adds: +12 dB. Enough for a laptop microphone at arm's length; not
 *  so much that a near-silent capture is turned into amplified hiss. */
export const LEVEL_MAX_GAIN = 4;

/** How far over full scale the limiter's curve reaches. A WaveShaper only shapes inputs in
 *  -1..1 and clamps the rest — a hard clip — so the leveller's gain goes in divided by this
 *  and the curve (softLimitCurve(LIMIT_HEADROOM)) multiplies it back: the same gain on
 *  ordinary speech, and a soft roll-off for anything up to the most the leveller can add. */
export const LIMIT_HEADROOM = LEVEL_MAX_GAIN;

/** RNNoise's output RMS above which a moment counts as speech. Its output in a pause sits
 *  far below this — that is its job — so the gate does not need to adapt. */
export const SPEECH_GATE_DB = -50;

/** Speech needed before the first adjustment. */
export const LEVEL_WARMUP_MS = 1500;

export const LEVEL_RISE_DB_PER_S = 3;
export const LEVEL_FALL_DB_PER_S = 6;

/** How fast the speech-level estimate follows a louder or a quieter moment, per update. */
const LEVEL_ATTACK = 0.3;
const LEVEL_RELEASE = 0.05;

export type LevelState = {
  /** The gain to apply now, as a factor. */
  gain: number;
  /** The speaker's speech level so far, after RNNoise and before the gain. Null until heard. */
  levelDb: number | null;
  /** How much speech has been heard, in ms. */
  speechMs: number;
};

export const INITIAL_LEVEL: LevelState = { gain: MAKEUP_GAIN, levelDb: null, speechMs: 0 };

/** RMS of a block of samples, in dBFS. Silence comes out as a very large negative number
 *  rather than -Infinity, so it compares and averages like any other quiet value. */
export function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

const toDb = (gain: number) => 20 * Math.log10(gain);
const fromDb = (db: number) => 10 ** (db / 20);

/** One update of the leveller: the RMS of RNNoise's latest output, and the ms since the
 *  last update. */
export function nextLevel(prev: LevelState, inputDb: number, dtMs: number): LevelState {
  if (!(inputDb > SPEECH_GATE_DB) || dtMs <= 0) return prev;

  const levelDb =
    prev.levelDb === null
      ? inputDb
      : prev.levelDb + (inputDb > prev.levelDb ? LEVEL_ATTACK : LEVEL_RELEASE) * (inputDb - prev.levelDb);
  const speechMs = prev.speechMs + dtMs;
  if (speechMs < LEVEL_WARMUP_MS) return { gain: prev.gain, levelDb, speechMs };

  const wantDb = Math.min(
    Math.max(LEVEL_TARGET_DB - levelDb, toDb(MAKEUP_GAIN)),
    toDb(LEVEL_MAX_GAIN),
  );
  const nowDb = toDb(prev.gain);
  const step = Math.min(
    Math.max(wantDb - nowDb, -LEVEL_FALL_DB_PER_S * (dtMs / 1000)),
    LEVEL_RISE_DB_PER_S * (dtMs / 1000),
  );
  return { gain: fromDb(nowDb + step), levelDb, speechMs };
}
