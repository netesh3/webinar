"use client";

/* Picks sharp or video for the local screen share by watching it (lib/share-motion.ts).
 *
 * While the local user shares a screen, a few times a second:
 *   - the share's video track is drawn into a 64×36 canvas and turned into a luminance
 *     grid; the fraction of cells that moved since the last tick is the motion signal;
 *   - the share's own audio track, if it has one, is measured with an AnalyserNode.
 * The classifier decides, and a change is applied to the live share through
 * applyShareMode (contentHint + degradation preference + per-layer fps) — never more
 * than once per APPLY_GAP, so a borderline share cannot thrash the encoder.
 *
 * Cost: one 64×36 drawImage + getImageData (2,304 pixels) and one 512-sample analyser
 * read, four times a second. The share frame is already decoded for the encoder; the
 * downscale is the GPU's. Well under a millisecond a tick on a laptop.
 *
 * A file share is not watched: it is always video (lib/file-share.ts).
 *
 * Timers, not requestVideoFrameCallback: the presenter is usually looking at another
 * window, and a hidden tab's video element stops delivering frame callbacks. Timers are
 * throttled there (to about one a second) but keep running, and the classifier works
 * on timestamps, so a slower tick still decides on the same spans.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  Track,
  type LocalParticipant,
  type LocalTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { applyShareMode } from "./media";
import type { ShareMode } from "./share-mode";
import {
  AUDIO_RMS,
  changedFraction,
  initialMotionState,
  lumaGrid,
  nextMotionState,
  rms,
  type MotionState,
} from "./share-motion";

const GRID_W = 64;
const GRID_H = 36;
const TICK_MS = 250;
/** Never re-apply a mode sooner than this after the last apply. */
const APPLY_GAP = 3_000;

/* The live share's mode, for the presenter's own share notice to show. */
let current: ShareMode = "sharp";
const listeners = new Set<() => void>();
function setCurrent(mode: ShareMode) {
  if (mode === current) return;
  current = mode;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** What the local share is currently encoded as: "sharp" or "video". */
export function useLiveShareMode(): ShareMode {
  return useSyncExternalStore(subscribe, () => current, () => "sharp");
}

type Sampler = { stop: () => void };

/* Watches one share. `onMode` gets the classifier's decision whenever it changes. */
function startSampler(
  video: MediaStreamTrack,
  audio: MediaStreamTrack | undefined,
  onMode: (mode: ShareMode) => void,
): Sampler {
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.srcObject = new MediaStream([video]);
  void el.play().catch(() => {});

  const canvas = document.createElement("canvas");
  canvas.width = GRID_W;
  canvas.height = GRID_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let audioCtx: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let buf: Float32Array<ArrayBuffer> | undefined;
  if (audio && typeof AudioContext !== "undefined") {
    try {
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaStreamSource(new MediaStream([audio]));
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      buf = new Float32Array(analyser.fftSize);
      // Share start is a user gesture, so this normally resumes; if not, audio reads 0.
      void audioCtx.resume().catch(() => {});
    } catch {
      analyser = undefined;
    }
  }

  // Two grids, alternated: this tick's and the previous one. No allocation per tick.
  const grids = [new Uint8Array(GRID_W * GRID_H), new Uint8Array(GRID_W * GRID_H)];
  let prevGrid: Uint8Array | null = null;
  let state: MotionState = initialMotionState(performance.now());

  const tick = () => {
    if (!ctx || el.readyState < 2 || video.readyState === "ended") return;
    let changed = 0;
    try {
      ctx.drawImage(el, 0, 0, GRID_W, GRID_H);
      const data = ctx.getImageData(0, 0, GRID_W, GRID_H).data;
      const grid = lumaGrid(data, prevGrid === grids[0] ? grids[1] : grids[0]);
      changed = changedFraction(prevGrid, grid);
      prevGrid = grid;
    } catch {
      return;
    }
    let audible = false;
    if (analyser && buf) {
      analyser.getFloatTimeDomainData(buf);
      audible = rms(buf) > AUDIO_RMS;
    }
    const before = state.mode;
    state = nextMotionState(state, { t: performance.now(), changed, audio: audible });
    if (state.mode !== before) onMode(state.mode);
  };
  const timer = window.setInterval(tick, TICK_MS);

  return {
    stop() {
      window.clearInterval(timer);
      el.pause();
      el.srcObject = null;
      if (audioCtx) void audioCtx.close().catch(() => {});
    },
  };
}

/* Runs the sampler for the local participant's screen share while `enabled`, and
 * applies its decisions to the live track. Starts every share in sharp. */
export function useAutoShareMode(participant: LocalParticipant | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!participant || !enabled) {
      setCurrent("sharp");
      return;
    }
    let sampler: Sampler | undefined;
    let watched: LocalVideoTrack | undefined;
    let applied: ShareMode = "sharp";
    let appliedAt = 0;
    let wanted: ShareMode = "sharp";
    let pending: number | undefined;

    const apply = () => {
      pending = undefined;
      const track = watched;
      if (!track || wanted === applied) return;
      const since = performance.now() - appliedAt;
      if (since < APPLY_GAP) {
        pending = window.setTimeout(apply, APPLY_GAP - since);
        return;
      }
      const mode = wanted;
      applied = mode;
      appliedAt = performance.now();
      setCurrent(mode);
      void applyShareMode(track, mode).catch(() => {});
    };

    const attach = () => {
      const pub = participant.getTrackPublication(Track.Source.ScreenShare);
      const track = pub?.track as LocalVideoTrack | undefined;
      if (track === watched) return;
      sampler?.stop();
      sampler = undefined;
      watched = track;
      applied = "sharp";
      appliedAt = 0;
      wanted = "sharp";
      setCurrent("sharp");
      const media = track?.mediaStreamTrack;
      if (!track || !media) return;
      /* A share that is not in sharp yet (republished after a reconnect while a clip was
       * playing) is reset to the start state; the sampler re-detects within seconds. */
      if (media.contentHint === "motion") void applyShareMode(track, "sharp").catch(() => {});
      const audioPub = participant.getTrackPublication(Track.Source.ScreenShareAudio);
      const audio = (audioPub?.track as LocalTrack | undefined)?.mediaStreamTrack;
      sampler = startSampler(media, audio, (mode) => {
        wanted = mode;
        if (pending === undefined) apply();
      });
    };

    attach();
    // A share's track arrives a moment after the toggle; a reconnect republishes it.
    participant.on("localTrackPublished", attach);
    participant.on("localTrackUnpublished", attach);
    return () => {
      participant.off("localTrackPublished", attach);
      participant.off("localTrackUnpublished", attach);
      if (pending !== undefined) window.clearTimeout(pending);
      sampler?.stop();
      setCurrent("sharp");
    };
  }, [participant, enabled]);
}
