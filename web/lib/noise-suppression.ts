"use client";

import type { AudioProcessorOptions, LocalAudioTrack, TrackProcessor } from "livekit-client";
import { Track } from "livekit-client";
import { useEffect, useState } from "react";
import {
  INITIAL_HEALTH,
  INITIAL_LEVEL,
  LIMIT_HEADROOM,
  MAKEUP_GAIN,
  judgeWorklet,
  nextLevel,
  rmsDb,
  softLimitCurve,
  type LevelState,
  type WorkletHealth,
} from "./noise-suppression-policy";

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
 * The graph, in an AudioContext this processor owns:
 *
 *   mic → RnnoiseWorkletNode → wet → level (the leveller) → WaveShaper (limiter) ─┐
 *     └──────────────────────→ dry (silent unless RNNoise has to be bypassed) ─────┴→ destination
 *
 * and the destination's track is what gets published. AudioWorkletNode runs on the
 * render thread's own high-priority worklet thread, not the main thread.
 *
 * Its own context, not the Room's. It used to borrow the AudioContext LiveKit hands a
 * processor, and every property of that context belongs to somebody else:
 *   - LiveKit closes it on every Room disconnect. The recovery ladder (lib/recovery.ts)
 *     reconnects the same Room and republishes the same track, so a presenter came back
 *     publishing the output of a closed context — silence, with the mic showing live.
 *   - It runs at the output device's rate (44.1 kHz on plenty of machines, 16 kHz with a
 *     Bluetooth headset in call mode). RNNoise is a 48 kHz model; at any other rate its
 *     bands and pitch analysis are simply wrong.
 *   - The vendored worklet never receives the node's 'destroy' message (it listens with
 *     addEventListener and never calls port.start()), so a torn-down processor kept
 *     running with its own 16 MiB of WebAssembly memory until that context closed —
 *     which, being the Room's, was never. One leaked per toggle and per device switch.
 * A context of its own is asked for at 48 kHz (the browser resamples the microphone into
 * it), lives exactly as long as this processor, and is closed on destroy — which is the
 * one thing that reliably frees the worklet.
 *
 * Never silence. A processor that cannot produce sound leaves the raw microphone on the
 * air rather than publishing its own silent output:
 *   - A context that will not start (no user gesture yet: a rejoin straight back into the
 *     room, a link opened from an email) fails init, so LiveKit keeps the raw track; the
 *     hook tries again on the next tap or key press.
 *   - A worklet that never produces output (its WebAssembly failed to compile or
 *     instantiate — something it never reports) is caught by the watchdog and bypassed:
 *     the dry path carries the raw microphone through the same published track.
 *   - A context that stops later (Safari's 'interrupted', a suspend) and does not come
 *     back is reported to the hook, which takes the processor off.
 *   - A restart that cannot rebuild leaves processedTrack unset, which is LiveKit's
 *     signal to send the raw track instead (`processedTrack ?? newTrack`).
 *
 * The gain stage exists because RNNoise is not level-preserving. Its output is a
 * per-frame spectral mask applied to the input, and that mask does not settle at
 * unity gain even on frames it correctly recognises as speech — reported directly
 * as "when noise suppression is on, audio volume is also getting reduced," and a
 * well-known property of this exact model family (the same makeup-gain fix is
 * standard practice in, for example, the RNNoise plugin for OBS). It was a fixed 1.5×,
 * and a fixed gain is right for somebody close to a good microphone and not enough for
 * somebody at arm's length from a laptop's — "the host's voice is very low," from
 * exactly those. So it is a leveller now (see nextLevel in lib/noise-suppression-policy.ts):
 * it measures the speaker's speech after RNNoise, brings a quiet one up by as much as
 * 12 dB, never goes below the old 1.5×, and only moves while they are talking, so the
 * pauses are not turned up. A WaveShaper after it limits (softLimitCurve): a plain gain
 * pushed loud syllables past full scale, and the WebRTC sender hard-clips those.
 *
 * This replaces the constraint entirely rather than layering under it: two noise
 * suppressors in series (the browser's spectral one, then RNNoise) fight each other
 * more than they help, and RNNoise wants the rawest signal it can get. Echo
 * cancellation and automatic gain control are left on — those solve different
 * problems (a loudspeaker loop, a level that wanders) that RNNoise does not touch.
 *
 * Moving this from a capture constraint to a processor also means the toggle applies to
 * the track that is already live, immediately, rather than the next time the microphone
 * starts.
 */

const RNNOISE_WORKLET_PATH = "/rnnoise/workletProcessor.js";
const RNNOISE_WASM_PATH = "/rnnoise/rnnoise.wasm";
const RNNOISE_WASM_SIMD_PATH = "/rnnoise/rnnoise_simd.wasm";

/** The rate RNNoise's model is defined at: its 480-sample frames are 10 ms here. */
const RNNOISE_SAMPLE_RATE = 48_000;

/** How long a new context is given to reach 'running' before init gives up, on a page
 *  that has not been interacted with yet: there it is most likely the autoplay policy, and
 *  the raw microphone should not wait. */
const CONTEXT_START_TIMEOUT_MS = 1500;

/** The same, once the page has been interacted with. Then a slow start is a slow device —
 *  an output starting up over Bluetooth can take seconds in Firefox and Safari, which start
 *  contexts asynchronously — and is worth waiting for. */
const CONTEXT_START_SLOW_DEVICE_MS = 5000;

/** How long a context that stopped is given to come back, while the page is visible,
 *  before the hook is told. */
const CONTEXT_RESUME_GRACE_MS = 1500;

/** How often the watchdog compares what goes into the worklet with what comes out. */
const WATCHDOG_INTERVAL_MS = 500;

/** How often the leveller looks at the speaker's level and adjusts. */
const LEVEL_INTERVAL_MS = 100;

/** The longest gap one adjustment is allowed to account for. A hidden tab's timers can be
 *  throttled to once a minute, and one reading must not justify a minute's worth of change. */
const LEVEL_MAX_STEP_MS = 500;

/** Time constant of each gain change, so an adjustment is a glide rather than a step. */
const LEVEL_SMOOTHING_S = 0.1;

/** Whether this browser can run it at all — AudioWorklet is the hard requirement. */
export function noiseSuppressionSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    !!window.MediaStream
  );
}

/** Thrown by init when the processor's AudioContext will not start yet — the autoplay
 *  policy, before this page has had a user gesture. Not a failure the person can act on:
 *  the raw microphone stays on the air and the hook tries again on their next interaction. */
class NotStartedError extends Error {
  constructor() {
    super("audio processing can't start until the page has been interacted with");
    this.name = "NotStartedError";
  }
}

export type NoiseSuppressionDiagnostics = {
  /** starting → running; bypassed when the worklet produced nothing; broken when the
   *  context stopped and did not come back; destroyed once torn down. */
  phase: "starting" | "running" | "bypassed" | "broken" | "destroyed";
  contextState: string;
  sampleRate: number;
  /** The leveller's gain right now, in dB (+3.5 is the old fixed 1.5×). */
  levelGainDb: number;
  /** The speaker's speech level after RNNoise and before the gain, in dBFS; null until
   *  they have been heard. */
  speechLevelDb: number | null;
};

// The WASM binary is the same bytes for every track this participant ever publishes —
// loaded once and shared, not re-fetched every time the mic restarts or the toggle
// flips off and back on.
//
// Only success is remembered. A rejected load used to be kept for the life of the page,
// so one network blip during the prefetch below — which runs as the room mounts, exactly
// when the connection is busiest — disabled noise suppression until a reload, with the
// same toast on every retry.
let wasmBinary: Promise<ArrayBuffer> | null = null;
function loadWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinary) {
    const attempt = import("@sapphi-red/web-noise-suppressor")
      .then(({ loadRnnoise }) =>
        loadRnnoise({ url: RNNOISE_WASM_PATH, simdUrl: RNNOISE_WASM_SIMD_PATH }),
      )
      .then((binary) => {
        /* loadRnnoise never checks the HTTP status, so an error page — a 404, a proxy's
         * block page — arrives here as "the binary". The worklet would then fail to compile
         * it without telling anyone and publish silence. Checked here instead, where a
         * failure becomes an error somebody sees. */
        if (!WebAssembly.validate(binary)) {
          throw new Error("the noise suppression files didn't download correctly");
        }
        return binary;
      });
    wasmBinary = attempt;
    attempt.catch(() => {
      if (wasmBinary === attempt) wasmBinary = null;
    });
  }
  return wasmBinary;
}

/* A context made inside a user gesture, waiting for the next init to take it.
 *
 * Chrome lets a context start at any point after the page's first gesture, but Safari only
 * lets one start from inside the gesture's own event handler — and the attach that follows
 * a gesture is asynchronous. So the gesture handler makes the context synchronously and
 * leaves it here. */
let primed: AudioContext | null = null;

function createContext(atDeviceRate = false): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!atDeviceRate) {
    try {
      return new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE, latencyHint: "interactive" });
    } catch {
      // A browser that will not run a context at 48 kHz: fall through to its own rate.
    }
  }
  try {
    return new AudioContext({ latencyHint: "interactive" });
  } catch {
    return null;
  }
}

/** Called synchronously from a user gesture, before an attach is retried. */
function primeAudio(): void {
  if (primed && primed.state !== "closed") {
    void primed.resume().catch(() => {});
    return;
  }
  primed = createContext();
  void primed?.resume().catch(() => {});
}

/** Closes a primed context nothing is going to take. */
function releasePrimedAudio(): void {
  const ctx = primed;
  primed = null;
  if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
}

/** A running context for a new processor, or NotStartedError. */
async function openContext(atDeviceRate = false): Promise<AudioContext> {
  let ctx = !atDeviceRate && primed && primed.state !== "closed" ? primed : null;
  if (ctx) primed = null;
  else releasePrimedAudio();
  ctx ??= createContext(atDeviceRate);
  if (!ctx) throw new Error("this browser couldn't start audio processing");

  if (ctx.state !== "running") {
    const interacted =
      typeof navigator !== "undefined" && navigator.userActivation?.hasBeenActive === true;
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise((resolve) =>
        setTimeout(resolve, interacted ? CONTEXT_START_SLOW_DEVICE_MS : CONTEXT_START_TIMEOUT_MS),
      ),
    ]);
  }
  if (ctx.state !== "running") {
    await ctx.close().catch(() => {});
    throw new NotStartedError();
  }
  return ctx;
}

function peak(buf: Float32Array): number {
  let max = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > max) max = v;
  }
  return max;
}

type RnnoiseNode = AudioWorkletNode & { destroy(): void };
type RnnoiseNodeClass = new (
  ctx: AudioContext,
  options: { wasmBinary: ArrayBuffer; maxChannels: number },
) => RnnoiseNode;

/** A microphone this context's rate cannot take: Firefox, before it resampled a
 *  MediaStream into a context at another rate, refused with NotSupportedError. */
function isRateMismatch(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotSupportedError";
}

class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "rnnoise-noise-suppression";
  processedTrack?: MediaStreamTrack;

  private ctx?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private node?: RnnoiseNode;
  private wet?: GainNode;
  private dry?: GainNode;
  private shaper?: WaveShaperNode;
  private destination?: MediaStreamAudioDestinationNode;
  private inputMeter?: AnalyserNode;
  private outputMeter?: AnalyserNode;
  private level?: GainNode;
  private levelMeter?: AnalyserNode;
  private leveler?: ReturnType<typeof setInterval>;
  private levelState: LevelState = INITIAL_LEVEL;
  private watchdog?: ReturnType<typeof setInterval>;
  private onVisible?: () => void;
  private phase: NoiseSuppressionDiagnostics["phase"] = "starting";
  private bypassed = false;
  private destroyed = false;
  private brokenReported = false;

  /** `onBroken` is told when the published track can no longer carry sound and the raw
   *  microphone has to go back on: the context stopped and did not come back, or a
   *  restart could not rebuild the graph. */
  constructor(private readonly onBroken: (reason: string) => void) {}

  async init(opts: AudioProcessorOptions): Promise<void> {
    const [{ RnnoiseWorkletNode }, binary] = await Promise.all([
      import("@sapphi-red/web-noise-suppressor"),
      loadWasmBinary(),
    ]);
    this.assertAlive();

    try {
      await this.start(opts.track, RnnoiseWorkletNode, binary, false);
    } catch (err) {
      this.closeContext();
      if (!isRateMismatch(err) || this.destroyed) throw err;
      // Run at the device's own rate instead. RNNoise is worse there, but no worse than it
      // was when it ran in the Room's context at that rate, and the microphone works.
      try {
        await this.start(opts.track, RnnoiseWorkletNode, binary, true);
      } catch (retryErr) {
        this.closeContext();
        throw retryErr;
      }
    }
  }

  /** Only the capture changed — another device, a headset unplugged, a microphone
   *  re-acquired. So only the source is replaced; the worklet, the context and above all
   *  processedTrack carry on. LiveKit re-reads processedTrack after this and puts it on
   *  the sender, and it being the same track means the recorder and the captions, which
   *  hold it, keep hearing the presenter through the switch. LiveKit passes no
   *  audioContext here, which no longer matters: the context is this processor's own. */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    const ctx = this.ctx;
    if (this.destroyed || !ctx || ctx.state === "closed" || !this.node || !this.destination) {
      this.giveUp("restart without a graph");
      return;
    }
    try {
      const next = ctx.createMediaStreamSource(new MediaStream([opts.track]));
      this.connectSource(next);
      this.source?.disconnect();
      this.source = next;
      // A different microphone is a different level: what the leveller learned of a laptop
      // microphone at arm's length would make a headset's first words far too loud.
      this.levelState = INITIAL_LEVEL;
      this.level?.gain.setTargetAtTime(MAKEUP_GAIN / LIMIT_HEADROOM, ctx.currentTime, 0.02);
    } catch (err) {
      console.warn("[noise suppression] could not move to the new microphone", err);
      this.giveUp("restart failed");
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.phase = "destroyed";
    this.teardownGraph();
    this.closeContext();
  }

  /** For diagnostics; read by duck-typing, so nothing outside imports this class. */
  getDiagnostics(): NoiseSuppressionDiagnostics {
    return {
      phase: this.phase,
      contextState: this.ctx?.state ?? "none",
      sampleRate: this.ctx?.sampleRate ?? 0,
      levelGainDb: Math.round(20 * Math.log10(this.levelState.gain) * 10) / 10,
      speechLevelDb:
        this.levelState.levelDb === null ? null : Math.round(this.levelState.levelDb * 10) / 10,
    };
  }

  private async start(
    track: MediaStreamTrack,
    Node: RnnoiseNodeClass,
    binary: ArrayBuffer,
    atDeviceRate: boolean,
  ): Promise<void> {
    const ctx = await openContext(atDeviceRate);
    this.ctx = ctx;
    this.assertAlive();
    // Per context: a worklet module is registered with the context it will run in.
    await ctx.audioWorklet.addModule(RNNOISE_WORKLET_PATH);
    this.assertAlive();

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    // Mono: what a microphone capture actually is here, and RNNoise is a per-channel
    // model. Mixed down at the node's input rather than left to maxChannels, which on a
    // stereo capture processed the left channel and left the right one silent — a 6 dB
    // drop once the mono Opus encoder averaged the two.
    const node = new Node(ctx, { wasmBinary: binary, maxChannels: 1 });
    node.channelCount = 1;
    node.channelCountMode = "explicit";
    node.channelInterpretation = "speakers";

    const wet = ctx.createGain();
    const dry = ctx.createGain();
    dry.gain.value = 0;
    // The leveller's gain goes in divided by LIMIT_HEADROOM and the limiter's curve
    // multiplies it back, so the curve can shape an over up to the most the leveller adds
    // instead of clamping it. Starts at the old fixed 1.5×.
    const level = ctx.createGain();
    level.gain.value = MAKEUP_GAIN / LIMIT_HEADROOM;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softLimitCurve(LIMIT_HEADROOM);
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    const inputMeter = ctx.createAnalyser();
    inputMeter.fftSize = 2048;
    const outputMeter = ctx.createAnalyser();
    outputMeter.fftSize = 2048;
    const levelMeter = ctx.createAnalyser();
    // About 85 ms of every 100 ms update, so one reading is a moment of speech, not a syllable.
    levelMeter.fftSize = 4096;

    node.connect(wet);
    wet.connect(level);
    level.connect(shaper);
    shaper.connect(destination);
    dry.connect(destination);
    node.connect(outputMeter);
    node.connect(levelMeter);

    this.node = node;
    this.wet = wet;
    this.dry = dry;
    this.level = level;
    this.shaper = shaper;
    this.destination = destination;
    this.inputMeter = inputMeter;
    this.outputMeter = outputMeter;
    this.levelMeter = levelMeter;
    this.connectSource(source);
    this.source = source;
    this.processedTrack = destination.stream.getAudioTracks()[0];

    // A worklet that throws later — a WebAssembly trap mid-session — goes silent just like
    // one that never started, and by then the watchdog has stopped looking.
    node.onprocessorerror = () => this.bypass("the RNNoise worklet failed");
    ctx.addEventListener("statechange", this.onContextState);
    this.phase = "running";
    this.startWatchdog();
    this.startLeveler();
  }

  /** Follows the speaker's level and moves the gain toward it. See nextLevel. A timer on
   *  the main thread rather than a worklet of its own: it only ever sets a target the
   *  GainNode glides to, so a slow or throttled tick costs adaptation speed, never audio. */
  private startLeveler(): void {
    const meter = this.levelMeter;
    const gain = this.level;
    const ctx = this.ctx;
    if (!meter || !gain || !ctx) return;
    const buf = new Float32Array(meter.fftSize);
    let last = performance.now();

    this.leveler = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(now - last, LEVEL_MAX_STEP_MS);
      last = now;
      if (this.destroyed || this.bypassed || ctx.state !== "running") return;
      meter.getFloatTimeDomainData(buf);
      const next = nextLevel(this.levelState, rmsDb(buf), dt);
      if (next.gain !== this.levelState.gain) {
        gain.gain.setTargetAtTime(next.gain / LIMIT_HEADROOM, ctx.currentTime, LEVEL_SMOOTHING_S);
      }
      this.levelState = next;
    }, LEVEL_INTERVAL_MS);
  }

  private stopLeveler(): void {
    if (this.leveler !== undefined) clearInterval(this.leveler);
    this.leveler = undefined;
    if (this.levelMeter) {
      try {
        this.node?.disconnect(this.levelMeter);
      } catch {
        // Not connected; nothing to undo.
      }
    }
    this.levelMeter = undefined;
  }

  private connectSource(source: MediaStreamAudioSourceNode): void {
    if (!this.bypassed && this.node) source.connect(this.node);
    if (this.dry) source.connect(this.dry);
    if (this.inputMeter) source.connect(this.inputMeter);
  }

  /** Watches for a worklet that never produces sound. See judgeWorklet. Stops for good
   *  once it has its answer either way. */
  private startWatchdog(): void {
    const input = this.inputMeter;
    const output = this.outputMeter;
    if (!input || !output) return;
    const inBuf = new Float32Array(input.fftSize);
    const outBuf = new Float32Array(output.fftSize);
    let health: WorkletHealth = INITIAL_HEALTH;

    this.watchdog = setInterval(() => {
      if (this.destroyed || this.ctx?.state !== "running") return;
      input.getFloatTimeDomainData(inBuf);
      output.getFloatTimeDomainData(outBuf);
      health = judgeWorklet(health, peak(inBuf), peak(outBuf));
      if (health.verdict === "pending") return;
      this.stopWatchdog();
      if (health.verdict === "failed") this.bypass("RNNoise produced no audio");
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
    // The meters are only for the watchdog. Disconnected at their inputs: disconnect() on a
    // meter only drops its outputs, of which it has none, and would leave both rendering for
    // the rest of the session.
    if (this.inputMeter) {
      try {
        this.source?.disconnect(this.inputMeter);
      } catch {
        // Not connected; nothing to undo.
      }
    }
    if (this.outputMeter) {
      try {
        this.node?.disconnect(this.outputMeter);
      } catch {
        // Not connected; nothing to undo.
      }
    }
    this.inputMeter = undefined;
    this.outputMeter = undefined;
  }

  /** RNNoise is not producing sound: carry the raw microphone through the same published
   *  track instead. */
  private bypass(reason: string): void {
    if (this.bypassed || !this.wet || !this.dry) return;
    this.stopWatchdog();
    this.stopLeveler();
    this.bypassed = true;
    this.phase = "bypassed";
    console.warn(`[noise suppression] ${reason}; sending the microphone unprocessed`);
    this.wet.gain.value = 0;
    this.dry.gain.value = 1;
    if (this.source && this.node) {
      try {
        this.source.disconnect(this.node);
      } catch {
        // Not connected; nothing to undo.
      }
    }
  }

  private onContextState = (): void => {
    const ctx = this.ctx;
    if (this.destroyed || !ctx) return;
    // `string`: Safari also reports 'interrupted', which the DOM types do not list.
    const state: string = ctx.state;
    if (state === "running") return;
    if (state === "closed") {
      this.reportBroken("context closed");
      return;
    }
    void ctx.resume().catch(() => {});
    this.awaitResume(ctx);
  };

  /** Gives a stopped context CONTEXT_RESUME_GRACE_MS to come back, counted only while the
   *  page is visible. A page in the background — an iOS app switch, a locked screen, a
   *  phone call — cannot resume it, and Safari brings it back by itself once the page
   *  returns; giving up there would hand back the raw microphone for nothing. */
  private awaitResume(ctx: AudioContext): void {
    setTimeout(() => {
      if (this.destroyed || this.ctx !== ctx || ctx.state === "running") return;
      if (typeof document !== "undefined" && document.hidden) {
        if (this.onVisible) return;
        const onVisible = () => {
          if (document.hidden) return;
          this.stopWaitingForVisible();
          if (this.destroyed || this.ctx !== ctx || ctx.state === "running") return;
          void ctx.resume().catch(() => {});
          this.awaitResume(ctx);
        };
        this.onVisible = onVisible;
        document.addEventListener("visibilitychange", onVisible);
        return;
      }
      this.reportBroken(`context ${ctx.state}`);
    }, CONTEXT_RESUME_GRACE_MS);
  }

  private stopWaitingForVisible(): void {
    if (this.onVisible) document.removeEventListener("visibilitychange", this.onVisible);
    this.onVisible = undefined;
  }

  /** No graph to keep. processedTrack goes unset, so LiveKit puts the raw track on the
   *  sender instead of a dead one, and the hook is told so it can take this off. */
  private giveUp(reason: string): void {
    this.teardownGraph();
    this.processedTrack = undefined;
    this.reportBroken(reason);
  }

  private reportBroken(reason: string): void {
    if (this.brokenReported || this.destroyed) return;
    this.brokenReported = true;
    this.phase = "broken";
    // Not inline: this can be reached from inside LiveKit's own restart, which holds the
    // track lock that taking the processor off needs.
    setTimeout(() => this.onBroken(reason), 0);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("noise suppression was turned off while it started");
  }

  private teardownGraph(): void {
    this.stopWatchdog();
    this.stopLeveler();
    this.stopWaitingForVisible();
    this.ctx?.removeEventListener("statechange", this.onContextState);
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.destroy();
    this.wet?.disconnect();
    this.dry?.disconnect();
    this.level?.disconnect();
    this.shaper?.disconnect();
    this.destination?.disconnect();
    this.processedTrack?.stop();
    this.source = undefined;
    this.node = undefined;
    this.level = undefined;
    this.wet = undefined;
    this.dry = undefined;
    this.shaper = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
  }

  /** Not awaited: LiveKit awaits destroy() while it holds the track's lock, and a close()
   *  that never settled would wedge every later change to the microphone. */
  private closeContext(): void {
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }
}

/** The RNNoise processor on this track, if that is what it has. */
function rnnoiseOn(track: LocalAudioTrack): RnnoiseProcessor | undefined {
  const processor = track.getProcessor();
  return processor instanceof RnnoiseProcessor ? processor : undefined;
}

/** Stopped for good — the room left, the device released — as opposed to a capture that
 *  ended underneath LiveKit (a headset unplugged), which LiveKit re-acquires and hands the
 *  processor through restart(). */
function stoppedForGood(track: LocalAudioTrack): boolean {
  return !!(track as unknown as { manuallyStopped?: boolean }).manuallyStopped;
}

/** Attaches being made, by track, so a second caller waits for one rather than racing it.
 *  LiveKit only reports a processor once its init has finished. */
const attaching = new WeakMap<LocalAudioTrack, Promise<unknown>>();

/**
 * Keeps one microphone's processor in line with what is wanted.
 *
 * The track is the source of truth: each pass asks it what it has (`getProcessor()`)
 * rather than remembering what was put on it. Remembering is what went wrong before — a
 * ref that outlived its track, so a new microphone (after the host took the mic away and
 * gave it back) was never processed, and a toggle flipped off and on mid-attach that ended
 * with the setting on and nothing attached. Passes run one at a time and each reads the
 * latest wish, so the last toggle wins.
 *
 * A class rather than refs in the hook, so none of this is state React has to know about.
 */
class NoiseSuppressionController {
  private track: LocalAudioTrack | undefined;
  private enabled = false;
  private key: string | null = null;
  private running = false;
  private rerun = false;
  private active = false;
  private disarmGesture: (() => void) | null = null;

  constructor(private readonly setError: (error: string | null) => void) {}

  mount(): void {
    this.active = true;
  }

  unmount(): void {
    this.active = false;
    this.key = null;
    this.disarmGesture?.();
    releasePrimedAudio();
  }

  want(track: LocalAudioTrack | undefined, enabled: boolean): void {
    this.track = track;
    this.enabled = enabled;
    // sid, so a republished or replaced microphone is looked at again; mediaStreamID for
    // the moment before it has one.
    const key = `${track?.sid ?? track?.mediaStreamID ?? ""}:${enabled}`;
    if (key === this.key) return;
    this.key = key;
    void this.reconcile();
  }

  private report(error: string | null): void {
    if (this.active) this.setError(error);
  }

  private async reconcile(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun && this.active);
    } finally {
      this.running = false;
      // A context primed by a gesture is taken by the attach that uses it. One left over —
      // nothing needed attaching, or the attach failed before it got that far — would
      // otherwise stay open, with its output stream, for the rest of the session. After
      // the last pass rather than each one, so a gesture during a pass keeps its context
      // for the pass it asked for.
      releasePrimedAudio();
    }
  }

  private async pass(): Promise<void> {
    const { track, enabled } = this;
    if (!track || !this.active) return;
    await attaching.get(track)?.catch(() => {});

    const ours = rnnoiseOn(track);
    if (!enabled) {
      this.disarmGesture?.();
      if (ours) await track.stopProcessor().catch(() => {});
      this.report(null);
      return;
    }
    // Already on — running, or bypassed with the raw microphone flowing through it. And
    // some other processor on the microphone is not this controller's to replace.
    if (ours || track.getProcessor()) return;

    if (!noiseSuppressionSupported()) {
      this.report("This browser can't run enhanced noise suppression.");
      return;
    }

    const created: RnnoiseProcessor = new RnnoiseProcessor((reason) => {
      void this.takeBackOff(track, created, reason);
    });
    const attach = (async () => {
      try {
        await track.setProcessor(created);
      } catch (err) {
        // setProcessor can throw with the processor half-attached. The raw microphone
        // stays on the air either way; the processor comes back off and is destroyed.
        if (track.getProcessor() === created) await track.stopProcessor().catch(() => {});
        await created.destroy().catch(() => {});
        throw err;
      }
      // Stopped while it was attaching: LiveKit destroys the processors it knows about on
      // stop, and until init finished it did not know about this one. Only for good — a
      // capture that merely ended is re-acquired by LiveKit and reaches restart(), and a
      // processor destroyed under it would stay on the track, dead, until a toggle.
      if (stoppedForGood(track)) await created.destroy().catch(() => {});
    })();
    attaching.set(track, attach);

    try {
      await attach;
      this.report(null);
    } catch (err) {
      if (err instanceof NotStartedError) {
        // Nothing to tell anybody: their microphone is live, unprocessed, and their next
        // tap or key press starts the processing.
        this.armGestureRetry();
        return;
      }
      console.warn("[noise suppression] could not start", err);
      this.report(
        err instanceof Error
          ? `Couldn't start noise suppression: ${err.message}`
          : "Couldn't start noise suppression.",
      );
    } finally {
      if (attaching.get(track) === attach) attaching.delete(track);
    }
  }

  /** The processor can no longer carry sound. Off it comes, so LiveKit puts the raw
   *  microphone back, and it goes back on after the person's next interaction — not
   *  straight away, which for a context that will not run would only repeat this. */
  private async takeBackOff(
    track: LocalAudioTrack,
    processor: RnnoiseProcessor,
    reason: string,
  ): Promise<void> {
    console.warn("[noise suppression] taking RNNoise off the microphone:", reason);
    await attaching.get(track)?.catch(() => {});
    // Already replaced or gone: nothing of this one's to put back.
    if (track.getProcessor() !== processor) return;
    await track.stopProcessor().catch(() => {});
    this.armGestureRetry();
  }

  /** Tries again on the person's next interaction — pointerup and keydown, the events that
   *  grant user activation for touch as well as a mouse (a touch pointerdown does not) — or,
   *  where the browser allows a context to start on an already-activated page without a
   *  fresh gesture (Chrome), when the page comes back into view. */
  private armGestureRetry(): void {
    if (this.disarmGesture || !this.active) return;
    const onGesture = () => {
      disarm();
      // Synchronously, inside the gesture: see `primed`.
      primeAudio();
      void this.reconcile();
    };
    const onVisible = () => {
      if (document.hidden || navigator.userActivation?.hasBeenActive !== true) return;
      disarm();
      void this.reconcile();
    };
    const disarm = () => {
      window.removeEventListener("pointerup", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      document.removeEventListener("visibilitychange", onVisible);
      if (this.disarmGesture === disarm) this.disarmGesture = null;
    };
    window.addEventListener("pointerup", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    document.addEventListener("visibilitychange", onVisible);
    this.disarmGesture = disarm;
  }
}

/**
 * Attaches or detaches RNNoise on the given mic track to match `enabled`, and keeps
 * doing so as the track itself changes (mic restarted, device switched, a new track
 * after the host took the mic away and gave it back). See NoiseSuppressionController.
 *
 * Mirrors useVirtualBackground's shape (lib/backgrounds.ts), including leaving the
 * processor alone on unmount: it belongs to the track, and LiveKit destroys it when the
 * track stops.
 */
export function useNoiseSuppression(
  track: LocalAudioTrack | undefined,
  enabled: boolean,
): { error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const [controller] = useState(() => new NoiseSuppressionController(setError));

  useEffect(() => {
    controller.mount();
    return () => controller.unmount();
  }, [controller]);

  // After every render: the controller decides whether anything it cares about moved.
  useEffect(() => {
    controller.want(track, enabled);
  });

  // Downloaded ahead of the track existing, same reasoning as the background model:
  // by the time there is a track to attach to, the WASM is usually already in the
  // browser's cache and the toggle does not visibly stall. A failure here is forgotten
  // (see loadWasmBinary), so the real attempt simply tries again.
  useEffect(() => {
    if (!enabled || !noiseSuppressionSupported()) return;
    void loadWasmBinary().catch(() => {});
  }, [enabled]);

  return { error };
}
