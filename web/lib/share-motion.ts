/* Whether a screen share is showing a video, decided from what it looks like.
 *
 * The share's mode (lib/share-mode.ts) used to be a checkbox — "Optimize for video" —
 * and presenters did not know what it meant or when to tick it. This decides instead,
 * from two cheap signals sampled a few times a second while somebody shares:
 *
 *   changed  how much of the frame moved since the previous sample: the fraction of
 *            cells in a tiny (64×36) luminance grid that changed by more than a noise
 *            threshold (see auto-share-mode.ts). 0 is a still slide, 1 is a full-screen
 *            cut.
 *   audio    whether the share's own audio track is carrying sound.
 *
 * and it is deliberately slow to change its mind, in both directions:
 *
 *   to video  sustained motion — at least MOTION.ratio of the samples in the last
 *             MOTION.window ms moved MOTION.changed or more — or MOTION.audioFor ms of
 *             continuous share audio. A slide transition or a scroll through a document
 *             is one or two busy samples, not 80% of two seconds, so it does not flip.
 *   to sharp  MOTION.settle ms with no audio and almost no motion (under
 *             MOTION.quietRatio busy samples). A paused video, a slide after a clip.
 *
 * MOTION.changed is 0.06 of the frame, not something like a quarter: a video playing in
 * a browser window that is a fraction of the screen moves only that fraction of the
 * frame. A 640×360 player on a 1920×1080 screen is 11%; 6% catches it with margin,
 * while typing, a moving cursor or a blinking caret moves well under 1% of 2,304 cells.
 * What 6% does let through is a long, continuous scroll of more than two seconds, which
 * then reads as motion until it stops — acceptable, and it settles back within seconds.
 *
 * Timestamps, not sample counts, drive every rule, so a throttled sampler (a background
 * tab can drop to one tick a second) still decides on the same wall-clock spans.
 *
 * Pure: no DOM, so it runs under node tests.
 */

import type { ShareMode } from "./share-mode.ts";

export type MotionSample = {
  /** Milliseconds, monotonic. */
  t: number;
  /** Fraction of the frame that changed since the previous sample, 0..1. */
  changed: number;
  /** The share's audio is carrying sound at this sample. */
  audio: boolean;
};

export const MOTION = {
  /** A sample this much changed counts as motion. */
  changed: 0.06,
  /** Span looked at to decide "this is a video". */
  window: 2_000,
  /** Share of that span's samples that must be moving. */
  ratio: 0.8,
  /** The window must actually be covered this much before it can decide. */
  minSpan: 1_500,
  minSamples: 3,
  /** Continuous share audio this long means something is playing. */
  audioFor: 1_500,
  /** Quiet this long goes back to sharp. */
  settle: 5_000,
  /** "Quiet" tolerates this share of busy samples (a cursor, a spinner, a clock). */
  quietRatio: 0.2,
} as const;

export type MotionState = {
  mode: ShareMode;
  /** Recent samples, oldest first, trimmed to the longest span any rule reads. */
  samples: MotionSample[];
  /** When the current unbroken run of share audio began, or null. */
  audioSince: number | null;
  /** When the share last entered video mode (settle never fires sooner). */
  since: number;
};

export function initialMotionState(t = 0): MotionState {
  return { mode: "sharp", samples: [], audioSince: null, since: t };
}

const keep = Math.max(MOTION.window, MOTION.settle);

/** One sample in, the next state out. Never mutates `prev`. */
export function nextMotionState(prev: MotionState, sample: MotionSample): MotionState {
  const samples = [...prev.samples, sample].filter((s) => sample.t - s.t <= keep);
  const audioSince = sample.audio ? (prev.audioSince ?? sample.t) : null;
  const state: MotionState = { ...prev, samples, audioSince };

  if (prev.mode === "sharp") {
    if (looksLikeVideo(samples, audioSince, sample.t)) {
      return { ...state, mode: "video", since: sample.t };
    }
    return state;
  }

  // Video: hold it while anything is playing, and for `settle` after it stops.
  if (sample.t - prev.since >= MOTION.settle && hasSettled(samples, sample.t)) {
    return { ...state, mode: "sharp", since: sample.t };
  }
  return state;
}

function looksLikeVideo(samples: MotionSample[], audioSince: number | null, now: number): boolean {
  if (audioSince !== null && now - audioSince >= MOTION.audioFor) return true;
  const recent = samples.filter((s) => now - s.t <= MOTION.window);
  if (recent.length < MOTION.minSamples) return false;
  if (now - recent[0].t < MOTION.minSpan) return false;
  const moving = recent.filter((s) => s.changed >= MOTION.changed).length;
  return moving / recent.length >= MOTION.ratio;
}

function hasSettled(samples: MotionSample[], now: number): boolean {
  const recent = samples.filter((s) => now - s.t <= MOTION.settle);
  if (recent.length === 0) return false;
  // The settle span has to be covered, not just one quiet sample after a gap.
  if (now - recent[0].t < MOTION.settle - 1_000) return false;
  if (recent.some((s) => s.audio)) return false;
  const busy = recent.filter((s) => s.changed >= MOTION.changed).length;
  return busy / recent.length <= MOTION.quietRatio;
}

/* How much of a frame changed, from two luminance grids of the same size.
 *
 * `threshold` is in 0..255 luma steps. Screen capture is lossless at the source, but
 * the downscale to the grid averages blocks with sub-pixel jitter frame to frame (and
 * some platforms render a cursor into the capture), so a cell has to move by a few
 * steps to count. Returns 0 for a first frame (no previous grid) or a size mismatch. */
export function changedFraction(
  prev: ArrayLike<number> | null,
  next: ArrayLike<number>,
  threshold = 8,
): number {
  if (!prev || prev.length !== next.length || next.length === 0) return 0;
  let changed = 0;
  for (let i = 0; i < next.length; i++) {
    if (Math.abs(next[i] - prev[i]) > threshold) changed++;
  }
  return changed / next.length;
}

/* Luma of an RGBA pixel buffer (ImageData.data), one byte per pixel.
 * Rec. 601 weights in integer arithmetic; exactness does not matter, stability does. */
export function lumaGrid(rgba: ArrayLike<number>, out?: Uint8Array): Uint8Array {
  const n = Math.floor(rgba.length / 4);
  const grid = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    grid[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return grid;
}

/** RMS of an audio buffer (-1..1 floats). */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Share audio this loud counts as playing: about -40 dBFS, above a quiet room's hiss. */
export const AUDIO_RMS = 0.01;
