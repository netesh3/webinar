"use client";

import type { AudioProcessorOptions, LocalAudioTrack, TrackProcessor } from "livekit-client";
import { Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";

/* Enhanced noise suppression: RNNoise, running as a LiveKit audio TrackProcessor.
 *
 * What was here before was the browser's own `noiseSuppression` MediaTrackConstraint —
 * a single boolean handed to getUserMedia. Chrome and Firefox both ship something
 * behind that flag, but it is tuned for steady, stationary noise (a hiss, a hum) and
 * is exactly the class of algorithm that lets a laptop fan through: a fan is close
 * enough to voice-band and non-stationary enough (it isn't a pure tone) that classical
 * spectral subtraction only takes the edge off it. Reported directly as "I can easily
 * hear fan noise of host."
 *
 * Zoom and Teams both ship a trained denoiser instead of a DSP filter, which is the
 * actual difference in quality. LiveKit's own answer to that is Krisp
 * (@livekit/krisp-noise-filter) — but it only runs against LiveKit Cloud's licensing,
 * and this deployment runs its own SFU on Hetzner, so that package is a dead end here.
 * RNNoise (xiph.org, BSD-licensed, the same model family Discord and Mumble built
 * their reputation on) is the open, self-hostable equivalent: also a trained model,
 * also real-time, and @sapphi-red/web-noise-suppressor packages it as a plain
 * AudioWorkletNode with no server or account involved. See public/rnnoise/README.md
 * for where the WASM comes from.
 *
 * The graph: MediaStreamAudioSourceNode(mic) → RnnoiseWorkletNode → GainNode
 * (MAKEUP_GAIN) → MediaStreamAudioDestinationNode, and the destination's track is
 * what gets published. AudioWorkletNode runs on the render thread's own
 * high-priority worklet thread, not the main thread — same reason the video
 * segmenter stays off the main thread, just a browser-native mechanism instead of
 * a hand-rolled one.
 *
 * The gain stage exists because RNNoise is not level-preserving. Its output is a
 * per-frame spectral mask applied to the input, and that mask does not settle at
 * unity gain even on frames it correctly recognises as speech — reported directly
 * as "when noise suppression is on, audio volume is also getting reduced," and a
 * well-known property of this exact model family (the same makeup-gain fix is
 * standard practice in, for example, the RNNoise plugin for OBS). MAKEUP_GAIN is a
 * fixed heuristic rather than a measured one: comparing input and output RMS in
 * real time to correct it exactly would need its own AnalyserNode pass every frame
 * for a gain a fixed constant already gets close enough to, and a wrong measurement
 * pumping the level up and down under someone's own voice would be worse than a
 * fixed boost that undershoots on a quiet speaker or overshoots slightly on a loud
 * one.
 *
 * This replaces the constraint entirely rather than layering under it: two noise
 * suppressors in series (the browser's spectral one, then RNNoise) fight each other
 * more than they help, and RNNoise wants the rawest signal it can get. Echo
 * cancellation and automatic gain control are left on — those solve different
 * problems (a loudspeaker loop, a level that wanders) that RNNoise does not touch.
 *
 * A second, unplanned improvement falls out of moving this from a capture constraint
 * to a processor: the constraint could only be changed by restarting the microphone
 * (see the removed effect in webinar-room.tsx, and Settings' old "applies the next
 * time your microphone starts" copy), because a MediaTrackConstraint is fixed for a
 * capture's lifetime. setProcessor/stopProcessor apply to the track that is already
 * live, so the toggle now takes effect immediately.
 */

const MAKEUP_GAIN = 1.5;

const RNNOISE_WORKLET_PATH = "/rnnoise/workletProcessor.js";
const RNNOISE_WASM_PATH = "/rnnoise/rnnoise.wasm";
const RNNOISE_WASM_SIMD_PATH = "/rnnoise/rnnoise_simd.wasm";

/** Whether this browser can run it at all — AudioWorklet is the hard requirement. */
export function noiseSuppressionSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    !!window.MediaStream
  );
}

// The WASM binary is the same bytes for every track this participant ever publishes —
// loaded once and shared, not re-fetched every time the mic restarts or the toggle
// flips off and back on.
let wasmBinary: Promise<ArrayBuffer> | null = null;
function loadWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinary) {
    wasmBinary = import("@sapphi-red/web-noise-suppressor").then(({ loadRnnoise }) =>
      loadRnnoise({ url: RNNOISE_WASM_PATH, simdUrl: RNNOISE_WASM_SIMD_PATH }),
    );
  }
  return wasmBinary;
}

// addModule is keyed to the AudioContext it was called on, and LiveKit can hand this
// processor the same context across multiple init calls (mic restarts, device
// switches). Re-registering the same URL on a context that already has it throws in
// some browsers, so this is tracked rather than called unconditionally.
const registeredContexts = new WeakMap<AudioContext, Promise<void>>();
function ensureWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = registeredContexts.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(RNNOISE_WORKLET_PATH);
    registeredContexts.set(ctx, p);
  }
  return p;
}

class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "rnnoise-noise-suppression";
  processedTrack?: MediaStreamTrack;

  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode & { destroy(): void };
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = opts.audioContext;
    const [{ RnnoiseWorkletNode }, binary] = await Promise.all([
      import("@sapphi-red/web-noise-suppressor"),
      loadWasmBinary(),
    ]);
    await ensureWorkletRegistered(ctx);

    const source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    // Mono: what a microphone capture actually is here, and RNNoise is a per-channel
    // model — asking for more channels than the source has is pure idle cost.
    const node = new RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 });
    const gain = ctx.createGain();
    gain.gain.value = MAKEUP_GAIN;
    const destination = ctx.createMediaStreamDestination();

    source.connect(node);
    node.connect(gain);
    gain.connect(destination);

    this.source = source;
    this.node = node;
    this.gain = gain;
    this.destination = destination;
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    // The WASM binary and the context's worklet registration are both still good —
    // only the graph around this particular capture needs rebuilding.
    this.teardownGraph();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.teardownGraph();
  }

  private teardownGraph(): void {
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.destroy();
    this.gain?.disconnect();
    this.destination?.disconnect();
    this.processedTrack?.stop();
    this.source = undefined;
    this.node = undefined;
    this.gain = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
  }
}

/**
 * Attaches or detaches RNNoise on the given mic track to match `enabled`, and keeps
 * doing so as the track itself changes (mic restarted, device switched).
 *
 * Mirrors useVirtualBackground's shape (lib/backgrounds.ts) — a processor built once
 * and torn down on unmount, an effect keyed on the track's identity rather than the
 * object (LiveKit hands back a new wrapper per render for the same underlying track).
 */
export function useNoiseSuppression(
  track: LocalAudioTrack | undefined,
  enabled: boolean,
): { error: string | null } {
  const processor = useRef<RnnoiseProcessor | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Downloaded ahead of the track existing, same reasoning as the background model:
  // by the time there is a track to attach to, the WASM is usually already in the
  // browser's cache and the toggle does not visibly stall.
  useEffect(() => {
    if (!enabled || !noiseSuppressionSupported()) return;
    void loadWasmBinary().catch(() => {});
  }, [enabled]);

  const sid = track?.sid ?? track?.mediaStreamID;

  useEffect(() => {
    if (!track) return;
    let cancelled = false;

    (async () => {
      if (!enabled) {
        if (processor.current) {
          try {
            await track.stopProcessor();
          } catch {
            // The track may already be gone. Not worth reporting.
          }
          await processor.current.destroy().catch(() => {});
          processor.current = null;
        }
        setError(null);
        return;
      }

      if (!noiseSuppressionSupported()) {
        setError("This browser can't run enhanced noise suppression.");
        return;
      }

      try {
        if (!processor.current) {
          const created = new RnnoiseProcessor();
          if (cancelled) {
            await created.destroy().catch(() => {});
            return;
          }
          processor.current = created;
          await track.setProcessor(created);
        }
        if (!cancelled) setError(null);
      } catch (err) {
        if (cancelled) return;
        processor.current = null;
        setError(
          err instanceof Error
            ? `Couldn't start noise suppression: ${err.message}`
            : "Couldn't start noise suppression.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, enabled]);

  // Torn down on unmount, not on every dependency change — leaving the worklet and
  // its WASM memory alive after somebody leaves the room is a leak that survives
  // until the tab closes.
  useEffect(
    () => () => {
      const current = processor.current;
      processor.current = null;
      void current?.destroy().catch(() => {});
    },
    [],
  );

  return { error };
}
