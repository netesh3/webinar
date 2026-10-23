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
 *   - It never goes above LEVEL_MAX_GAIN, nor so far that the room — what is there once the
 *     speaker has been quiet for PAUSE_AFTER_MS — comes out louder than PAUSE_CEILING_DB: a
 *     "silence" that is a television or a colleague is not turned up into.
 *   - It learns the speaker from the median of their first LEVEL_WARMUP_MS, so one loud
 *     first word is not who they are; after that, sound more than SPEAKER_RANGE_DB below
 *     them is not them — a voice across the room, what echo cancellation left of the other
 *     people, typing — and does not move the estimate, so the gain does not climb while the
 *     host is listening.
 *   - The estimate moves slowly (LEVEL_SMOOTHING, a step at most LEVEL_OUTLIER_DB off taken
 *     into account), so a laugh or a cough is not a verdict on anybody's voice.
 *   - The gain rises at most LEVEL_RISE_DB_PER_S and normally falls at LEVEL_FALL_DB_PER_S —
 *     but any moment that would come out more than HOT_MARGIN_DB over the target is cut at
 *     HOT_FALL_DB_PER_S at once, warm-up or not, and speech that is mostly that loud for
 *     REANCHOR_MS (a louder person on the microphone, or the same one leaning in) becomes
 *     the new estimate. */

/** Speech RMS after the gain, in dBFS, that the leveller aims for. Was −20, and attendees
 *  still reported "the host's voice is low": −16 is where Zoom and Meet deliver speech, so a
 *  webinar no longer sounds quieter than the call the audience just left. Speech peaks sit
 *  12–15 dB over its RMS, so the loudest syllables reach the limiter's knee and are rolled
 *  off there rather than clipped. A speaker whose RNNoise output already sits above
 *  LEVEL_TARGET_DB − 3.5 dB needs no more than MAKEUP_GAIN and is not touched. */
export const LEVEL_TARGET_DB = -16;

/** The most the leveller adds: +18 dB. Was +12, which a laptop microphone at arm's length
 *  after RNNoise could still be short of. PAUSE_CEILING_DB, not this, is what keeps a
 *  near-silent capture in a noisy room from being turned into amplified hiss. */
export const LEVEL_MAX_GAIN = 8;

/** How far over full scale the limiter's curve reaches. A WaveShaper only shapes inputs in
 *  -1..1 and clamps the rest — a hard clip — so the leveller's gain goes in divided by this
 *  and the curve (softLimitCurve(LIMIT_HEADROOM)) multiplies it back: the same gain on
 *  ordinary speech, and a soft roll-off for anything up to the most the leveller can add. */
export const LIMIT_HEADROOM = LEVEL_MAX_GAIN;

/** RNNoise's output RMS above which a moment counts as sound at all. Its output in a quiet
 *  pause sits far below this — that is its job. */
export const SPEECH_GATE_DB = -50;

/** Once the speaker is known, sound more than this far below them is not them. */
export const SPEAKER_RANGE_DB = 10;

/** The room, as it comes out, must stay under this. */
export const PAUSE_CEILING_DB = -45;

/** Quiet this long before what is heard counts as the room. The gaps between somebody's own
 *  words are shorter, and are not the room. */
export const PAUSE_AFTER_MS = 1000;

/** Speech heard before the first adjustment, and the median of which is the first estimate. */
export const LEVEL_WARMUP_MS = 1500;

export const LEVEL_RISE_DB_PER_S = 3;
export const LEVEL_FALL_DB_PER_S = 6;

/** A moment more than this over the target is too hot to wait for the estimate. */
export const HOT_MARGIN_DB = 6;
export const HOT_FALL_DB_PER_S = 30;

/** Speech mostly too hot for this long becomes the estimate. A laugh does not last it. */
export const REANCHOR_MS = 2500;

/** The estimate's smoothing per update, and how far off a reading is taken into account:
 *  a reading 30 dB louder moves it no further than one 6 dB louder. */
const LEVEL_SMOOTHING = 0.05;
export const LEVEL_OUTLIER_DB = 6;
const PAUSE_SMOOTHING = 0.05;

export type LevelState = {
  /** The gain to apply now, as a factor. */
  gain: number;
  /** The speaker's speech level, after RNNoise and before the gain. Null until learned. */
  levelDb: number | null;
  /** Readings of the speaker collected before levelDb is known. */
  warmup: readonly number[];
  /** How much of the speaker has been heard, in ms. */
  speechMs: number;
  /** The level of the room. Null until the speaker has been quiet long enough to hear it. */
  pauseDb: number | null;
  /** How long since the speaker was last heard, in ms. */
  quietMs: number;
  /** Time spent too hot, less half the time between, since the speaker last paused. */
  hotMs: number;
};

export const INITIAL_LEVEL: LevelState = {
  gain: MAKEUP_GAIN,
  levelDb: null,
  warmup: [],
  speechMs: 0,
  pauseDb: null,
  quietMs: 0,
  hotMs: 0,
};

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
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** One update of the leveller: the RMS of RNNoise's latest output, and the ms since the
 *  last update. */
export function nextLevel(prev: LevelState, inputDb: number, dtMs: number): LevelState {
  if (!Number.isFinite(inputDb) || !(dtMs > 0)) return prev;
  const seconds = dtMs / 1000;
  const floorDb = toDb(MAKEUP_GAIN);
  const maxDb = toDb(LEVEL_MAX_GAIN);
  let gainDb = toDb(prev.gain);
  let { levelDb, warmup, speechMs, pauseDb, quietMs, hotMs } = prev;

  const sound = inputDb > SPEECH_GATE_DB;
  const speaker = sound && (levelDb === null || inputDb > levelDb - SPEAKER_RANGE_DB);
  const hot = sound && inputDb + gainDb > LEVEL_TARGET_DB + HOT_MARGIN_DB;

  if (speaker) {
    speechMs += dtMs;
    quietMs = 0;
    if (levelDb === null) {
      warmup = [...warmup, inputDb];
      if (speechMs >= LEVEL_WARMUP_MS) {
        levelDb = median(warmup);
        warmup = [];
      }
    } else {
      levelDb += LEVEL_SMOOTHING * clamp(inputDb - levelDb, -LEVEL_OUTLIER_DB, LEVEL_OUTLIER_DB);
    }
  } else {
    quietMs += dtMs;
    if (quietMs >= PAUSE_AFTER_MS) {
      pauseDb = pauseDb === null ? inputDb : pauseDb + PAUSE_SMOOTHING * (inputDb - pauseDb);
    }
  }

  if (quietMs >= PAUSE_AFTER_MS) hotMs = 0;
  else if (hot) hotMs += dtMs;
  else if (sound) hotMs = Math.max(0, hotMs - dtMs / 2);
  if (hot && levelDb !== null && hotMs >= REANCHOR_MS) {
    levelDb = inputDb;
    hotMs = 0;
  }

  const capDb = pauseDb === null ? maxDb : clamp(PAUSE_CEILING_DB - pauseDb, floorDb, maxDb);
  if (speaker && levelDb !== null) {
    const wantDb = clamp(LEVEL_TARGET_DB - levelDb, floorDb, capDb);
    gainDb += clamp(wantDb - gainDb, -LEVEL_FALL_DB_PER_S * seconds, LEVEL_RISE_DB_PER_S * seconds);
  } else if (gainDb > capDb) {
    gainDb = Math.max(capDb, gainDb - LEVEL_FALL_DB_PER_S * seconds);
  }

  if (hot) {
    const hotDb = Math.max(LEVEL_TARGET_DB + HOT_MARGIN_DB - inputDb, floorDb);
    if (gainDb > hotDb) gainDb = Math.max(hotDb, gainDb - HOT_FALL_DB_PER_S * seconds);
  }

  return { gain: fromDb(gainDb), levelDb, warmup, speechMs, pauseDb, quietMs, hotMs };
}
