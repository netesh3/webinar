"use client";

import type {
  BackgroundProcessorWrapper,
  ProcessorWrapper,
} from "@livekit/track-processors";
import type {
  LocalParticipant,
  LocalVideoTrack,
  Track,
  TrackProcessor,
  VideoProcessorOptions,
} from "livekit-client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  Background,
  SegmenterOptions,
  SegmenterStatus,
  SoftSegmenter,
} from "./segmenter";

/* Virtual backgrounds: off, blur, or a bundled image.
 *
 * Two pipelines share this file, chosen per browser via `backgroundEngine`:
 *
 *   enhanced   SoftSegmenter (MediaPipe selfie model + our compositor) wrapped in
 *              @livekit/track-processors' ProcessorWrapper. Supports blur, image, and
 *              the low-light lift in one GPU pass. Default.
 *   livekit    LiveKit's built-in BackgroundProcessor from the same package (npm name
 *              @livekit/track-processors; GitHub track-processors-js). Blur and image
 *              only — no low-light. Opt-in for A/B comparison.
 *
 * Every frame goes camera → segmentation → alpha matte → composite over the chosen
 * background → canvas.captureStream(), and the processed stream replaces the published
 * track. Written by hand this is a WebGL program and a WASM loader; the processor does
 * it and plugs into LocalVideoTrack.setProcessor.
 *
 * Four decisions worth stating:
 *
 * The model is served from THIS origin. The processor defaults to fetching its WASM
 * from jsdelivr and the .tflite from googleapis, and both are routinely blocked on
 * corporate networks — the ones a webinar audience sits behind. A background that
 * silently fails to load for a quarter of the room is worse than one that is not
 * offered, so the assets are vendored into public/mediapipe (see the README) and
 * pointed at explicitly.
 *
 * The processor is attached once per track and SWITCHED. Tearing it down and rebuilding it
 * to change mode re-initialises the WASM and drops frames on the way through — visible to
 * the audience as a flash of black or of the real room. Changing the choice is a call on
 * the processor that is already running, and so is turning it all off. Switching *engines*
 * does tear down and rebuild — the two transformers are not interchangeable.
 *
 * The processor belongs to the TRACK, not to the screen that attached it. The pre-join
 * screen hands its camera track to the room, processor and all, and the room adopts it
 * rather than building another — so joining is not a second model load with the room on
 * show while it happens. It goes when the track is stopped, which LiveKit does for us.
 *
 * The processor goes on as the camera OPENS, not after it. LiveKit attaches a processor it
 * is handed with the camera before it gives the track to anybody, so the first frame shown —
 * in the preview, or to the audience — is already processed. Attached afterwards, the room
 * was on show for as long as the attach took, and in the room that is to everyone watching.
 * See openCamera.
 */

// ------------------------------------------------------------------ the catalogue

export type BackgroundMode = "none" | "blur" | "image";

/** Which virtual-background pipeline runs. Persisted in media preferences. */
export type BackgroundEngine = "enhanced" | "livekit";

export const DEFAULT_BACKGROUND_ENGINE: BackgroundEngine = "enhanced";

/** Narrow storage / unknown input to a known engine. Anything else → enhanced. */
export function asBackgroundEngine(value: unknown): BackgroundEngine {
  return value === "livekit" ? "livekit" : "enhanced";
}

/** One-line label for settings rows and the A/B toggle. */
export function describeBackgroundEngine(engine: BackgroundEngine): string {
  return engine === "livekit" ? "LiveKit" : "Enhanced";
}

export type VirtualBackgroundId =
  | "office"
  | "library"
  | "horizon"
  | "conference"
  | "studio"
  | "sage";

export type BackgroundChoice =
  | { mode: "none" }
  | { mode: "blur" }
  | { mode: "image"; id: VirtualBackgroundId };

export const VIRTUAL_BACKGROUNDS: readonly {
  id: VirtualBackgroundId;
  label: string;
  src: string;
}[] = [
  { id: "office", label: "Office", src: "/backgrounds/office.jpg" },
  { id: "library", label: "Library", src: "/backgrounds/library.jpg" },
  { id: "horizon", label: "Horizon", src: "/backgrounds/horizon.jpg" },
  { id: "conference", label: "Conference", src: "/backgrounds/conference.jpg" },
  { id: "studio", label: "Studio", src: "/backgrounds/studio.jpg" },
  { id: "sage", label: "Sage", src: "/backgrounds/sage.jpg" },
];

const BACKGROUND_IDS = new Set<string>(VIRTUAL_BACKGROUNDS.map((b) => b.id));

export const NO_BACKGROUND: BackgroundChoice = { mode: "none" };

/* How hard to blur: a Gaussian sigma of 28 pixels at 720p, scaled for other sizes.
 *
 * Strong enough that a room is unreadable — a bookshelf is colour, not titles — which is
 * what somebody choosing "blur" is asking for, and about what Zoom and Meet do. It was 24;
 * 28 is one step stronger so the cut-out reads cleaner against the room without changing
 * the room-only blur path (person is still taken out before the blur; see segmenter.ts).
 * Half of this is the worst of both: the room is still legible and the person looks cut out.
 */
const BLUR_RADIUS = 28;

/** Vendored MediaPipe assets — both engines point here so corporate CDNs are not required. */
const MEDIAPIPE_WASM = "/mediapipe/wasm";
const MEDIAPIPE_MODEL = "/mediapipe/selfie_segmenter_landscape.tflite";

// ------------------------------------------------------------------- low light

/* The slider's range, in the units the preference is stored in.
 *
 * 0..100 rather than 0..1 because it is what reads well next to a slider ("40%"), and
 * because an integer survives a JSON round trip through localStorage without accreting
 * float noise. The shader wants 0..1; lowLightAmount is the one place that divides.
 */
export const LOW_LIGHT_MAX = 100;

/** Slider steps. Fine enough to find the right amount, coarse enough that dragging
 *  from one end to the other is a handful of uniform writes rather than a hundred. */
export const LOW_LIGHT_STEP = 5;

/* What the one-click version turns on.
 *
 * Measured rather than picked: at 50 a face midtone goes 64 -> 99 while a near-white 240
 * only reaches 246 (see e2e/probe-low-light.mjs, which prints that table). Visibly lit and
 * short of the point where a webcam's shadow noise comes up with the face — so it is the
 * right answer for somebody who wants the problem gone rather than a control to operate.
 */
export const LOW_LIGHT_DEFAULT_ON = 50;

/**
 * asLowLight narrows whatever was in storage to a usable amount.
 *
 * Same job as asBackgroundChoice and the same reason: preferences are persisted as JSON
 * and read back with a spread, so this can be a string, a NaN, or 5000 from a hand-edited
 * value. An unchecked number reaches the shader as the gamma exponent, where a negative
 * one inverts the picture and a huge one flattens it to white — both of which a presenter
 * would see and have no way to explain.
 */
export function asLowLight(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), 0), LOW_LIGHT_MAX);
}

/** Stored units to shader units. */
function lowLightAmount(stored: number): number {
  return asLowLight(stored) / LOW_LIGHT_MAX;
}

/** A one-line description for a settings row, matching describeBackground. */
export function describeLowLight(stored: number): string {
  const n = asLowLight(stored);
  return n === 0 ? "Off" : `${n}%`;
}

/**
 * asBackgroundChoice narrows whatever was in storage to a mode that still exists.
 *
 * Needed because preferences are persisted as JSON and read back with a spread, so a browser
 * that saved `{ mode: "image", id: "aurora" }` under an older build still has it. Without this
 * that value would reach the segmenter, match no branch, and leave a presenter with a black or
 * unprocessed frame and nothing in the UI to explain it.
 *
 * An unrecognised image id becomes "blur" rather than "none": somebody who had chosen a
 * background wanted their room hidden, and silently revealing it is the worse of the two
 * failures.
 */
export function asBackgroundChoice(value: unknown): BackgroundChoice {
  const rec = value as { mode?: unknown; id?: unknown } | null | undefined;
  const mode = rec?.mode;
  if (mode === "none") return { mode: "none" };
  if (mode === "blur") return { mode: "blur" };
  if (mode === "image") {
    const id = rec?.id;
    if (typeof id === "string" && BACKGROUND_IDS.has(id)) {
      return { mode: "image", id: id as VirtualBackgroundId };
    }
    return { mode: "blur" };
  }
  if (typeof mode === "string") return { mode: "blur" };
  return NO_BACKGROUND;
}

/** A one-line description of the current choice, for a settings row. */
export function describeBackground(choice: BackgroundChoice): string {
  if (choice.mode === "blur") return "Blurred";
  if (choice.mode === "image") {
    return VIRTUAL_BACKGROUNDS.find((b) => b.id === choice.id)?.label ?? "Background";
  }
  return "Off";
}

/**
 * describeBackgroundError words a failure for the presenter who has to act on it.
 *
 * What reaches here is whatever the browser, the WASM or the GPU threw, and it used to be
 * shown as it was. The report that prompted this was a pre-join screen reading
 *
 *   Couldn't start the background: Unable to initialize ... kGpuService ... Error querying
 *   for GL extensions
 *
 * as one unbreakable line that pushed the page sideways — accurate, and useless to anybody
 * but whoever wrote the GPU delegate. The question a presenter has is what to DO, and for
 * nearly every real failure there are only three answers: free up the graphics card, fix
 * the connection, or pick something else. The raw error still goes to the console in full;
 * see the console.error in useVirtualBackground.
 *
 * `lowLightOnly` is for when no background was asked for — only the lift — where "couldn't
 * start the background" would name a feature the presenter did not turn on.
 */
export function describeBackgroundError(err: unknown, lowLightOnly = false): string {
  const what = lowLightOnly ? "adjust your video" : "start the background";
  const text = errorText(err).toLowerCase();

  /* The graphics context going away, however it surfaces. From our own code it is the
   * CONTEXT_LOST sentence in lib/segmenter.ts; from inside MediaPipe it is kGpuService, a
   * failed extension query, or a null read of the context's attributes. All the same
   * thing: the browser has more WebGL contexts open than it will keep. */
  if (
    /graphics capacity|context lost|context_lost|kgpuservice|querying for gl extensions|reading 'alpha'|webgl/.test(
      text,
    )
  ) {
    return `Couldn't ${what}: your browser ran out of graphics capacity. Close a few tabs and try again.`;
  }
  if (
    /failed to fetch|networkerror|load failed|dynamically imported module|importing a module script failed|loading chunk|chunkloaderror/.test(
      text,
    )
  ) {
    return lowLightOnly
      ? "Couldn't load the video adjustment. Check your connection and try again."
      : "Couldn't download the background effect. Check your connection and try again.";
  }
  if (text.includes("background image failed to load")) {
    return "Couldn't load that background image. Try again or pick another one.";
  }
  /* Emscripten's half-drained start-up callbacks — see oneAtATime in lib/segmenter.ts.
   *
   * Named rather than folded into the catch-all: Retry alone rarely clears a corrupted
   * Module, and "reload the page" is the action that does. The string is stable across
   * MediaPipe versions and is what the console shows when dispose races create. */
  if (/callbacks\.shift/.test(text)) {
    return `Couldn't ${what}: the effect engine was interrupted. Reload the page and try again.`;
  }
  /* Catch-all: keep it short for the presenter, but keep a clipped hint so a screenshot of
   * the yellow box is enough to tell the next failure from the last without DevTools.
   * Long GPU sentences still go through the patterns above; this only runs for unknowns. */
  const hint = clippedErrorHint(err);
  if (hint) {
    return `Couldn't ${what} (${hint}). Try again, or reload the page if it keeps happening.`;
  }
  return `Couldn't ${what}. Try again, or reload the page if it keeps happening.`;
}

/** A short, screenshot-safe excerpt of an unknown failure — never a multi-line GPU dump. */
function clippedErrorHint(err: unknown, max = 72): string | null {
  const raw = errorText(err).replace(/\s+/g, " ").trim();
  if (!raw || raw === "undefined" || raw === "null") return null;
  // Skip values that are only noise when stringified.
  if (/^\[object \w+\]$/i.test(raw)) return null;
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}

/** Every message in an error and the chain of causes behind it, as one string. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let at: unknown = err;
  // Bounded, because a cause chain is only a convention and can loop.
  for (let depth = 0; depth < 5 && at != null; depth++) {
    if (typeof at === "string") {
      parts.push(at);
      break;
    }
    const rec = at as { message?: unknown; cause?: unknown };
    if (typeof rec.message === "string") parts.push(rec.message);
    else parts.push(String(at));
    at = rec.cause;
  }
  return parts.join(" | ");
}

/* What a frame costs, published for the settings window to read.
 *
 * Reported rather than asserted: "this is faster now" is not something anybody should
 * take on trust, and a presenter wondering whether the background is what is making
 * their video stutter deserves to be able to look.
 *
 * A module-level store with useSyncExternalStore rather than room context, because
 * the component that measures this (VirtualBackground, at the room level) and the one
 * that displays it (NetworkReadout, inside the settings window) are in different
 * subtrees — and threading telemetry up through a provider so it can come back down
 * is more machinery than a number deserves.
 */
export type FrameCost = { total: number; segment: number } | null;

let frameCost: FrameCost = null;
const costListeners = new Set<() => void>();

function publishFrameCost(next: FrameCost): void {
  frameCost = next;
  for (const listener of costListeners) listener();
}

function subscribeFrameCost(listener: () => void): () => void {
  costListeners.add(listener);
  return () => {
    costListeners.delete(listener);
  };
}

// The same object identity until it actually changes, which is what
// useSyncExternalStore requires to avoid re-rendering on every check.
const readFrameCost = () => frameCost;
const readFrameCostOnServer = (): FrameCost => null;

/** The averaged per-frame cost of the virtual background, or null when none is on. */
export function useBackgroundCost(): FrameCost {
  return useSyncExternalStore(subscribeFrameCost, readFrameCost, readFrameCostOnServer);
}

/* Where the background is, for every screen that shows it.
 *
 *   idle        nothing asked for
 *   preparing   asked for and on its way — the model downloading, a picture loading, the
 *               graphics context being rebuilt. The preview is veiled meanwhile, never the
 *               raw room, and this is what says why it is blurred.
 *   ready       showing what was asked for
 *   failed      given up. `error` is the sentence to show, `retryable` whether a Retry
 *               button could help — it cannot for a browser that lacks the API outright.
 *
 * A module-level store for the same reasons frameCost is one, with one more: the pre-join
 * screen and the room both show it, and the processor that reports it outlives the first
 * and is adopted by the second. And it is written from inside effects, where a setState
 * would be a cascading render and publishing to a store is not.
 *
 * `attempt` is the Retry button. Bumping it re-runs the attach effect, which asks the
 * processor to forget its failures, or attaches one afresh if none survived.
 */
export type BackgroundStatus = {
  phase: "idle" | "preparing" | "ready" | "failed";
  error: string | null;
  retryable: boolean;
  attempt: number;
};

let status: BackgroundStatus = { phase: "idle", error: null, retryable: false, attempt: 0 };
const statusListeners = new Set<() => void>();

function publishStatus(patch: Partial<BackgroundStatus>): void {
  const next = { ...status, ...patch };
  // Guarded, so a switch between two stills does not re-render every screen for no change.
  if (
    next.phase === status.phase &&
    next.error === status.error &&
    next.retryable === status.retryable &&
    next.attempt === status.attempt
  ) {
    return;
  }
  status = next;
  for (const listener of statusListeners) listener();
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

const readStatus = () => status;
const IDLE: BackgroundStatus = { phase: "idle", error: null, retryable: false, attempt: 0 };
const readStatusOnServer = (): BackgroundStatus => IDLE;

/** Where the virtual background is. See BackgroundStatus. */
export function useBackgroundStatus(): BackgroundStatus {
  return useSyncExternalStore(subscribeStatus, readStatus, readStatusOnServer);
}

/** Tries a failed background again. Shows as preparing straight away, so the click is
 *  seen to have done something before the processor has had a chance to answer. */
export function retryBackground(): void {
  publishStatus({ phase: "preparing", error: null, retryable: false, attempt: status.attempt + 1 });
}

// ------------------------------------------------------------------- the processor

/* How slow is too slow.
 *
 * A frame budget of 33ms is 30fps. Sustained work above SLOW_FRAME_MS means the device
 * cannot keep up, and the honest response is to say so and turn it off rather than to
 * publish a stuttering track — the audience sees the stutter, and the person causing it
 * does not. Measured over a window, because one slow frame is a garbage collection.
 */
const SLOW_FRAME_MS = 42;
const SLOW_FRAME_WINDOW = 90;
const SLOW_FRAME_LIMIT = 55;

/* Turns a choice into what the compositor needs.
 */
function backgroundFor(choice: BackgroundChoice): Background {
  if (choice.mode === "blur") return { kind: "blur", radius: BLUR_RADIUS };
  if (choice.mode === "image") {
    const item = VIRTUAL_BACKGROUNDS.find((b) => b.id === choice.id);
    return item
      ? { kind: "image", src: item.src }
      : { kind: "blur", radius: BLUR_RADIUS };
  }
  return { kind: "none" };
}

/* Which tracks have a processor on the way, and which Retry each processor has seen.
 *
 * `attaching` is how a screen avoids racing an attach: LiveKit only reports a processor once
 * init has finished, so for the second or so before that a track looks bare, and a second
 * attach in that window would stop the first and load the model twice. Weak, so it does not
 * keep a stopped track alive. `retried` is the last Retry each processor has seen, so it
 * retries once per click whichever screen is holding it.
 *
 * `openingCamera` is the same idea for openCamera: the pre-join screen opens the camera
 * WITH a processor, then hands the track to useVirtualBackground. Until open() resolves
 * there is no track to put in `attaching`, so without this the hook can start a second
 * createProcessor against a bare-looking track while LiveKit is still inside setProcessor.
 */
const attaching = new WeakMap<LocalVideoTrack, Promise<unknown>>();
let openingCamera: Promise<unknown> | null = null;

let supported: boolean | undefined;

/**
 * Build-time kill switch for virtual backgrounds and the low-light lift (shared WebGL /
 * MediaPipe path). Set NEXT_PUBLIC_VIRTUAL_BACKGROUNDS=0 at build time to hide the
 * controls if the effect engine regresses. Unset (or =1) keeps them on; production
 * Cloudflare deploys currently set =1.
 *
 * Distinct from `backgroundsSupported()`: when this is false the UI must hide the
 * controls, not claim the browser needs WebGL2. See web/public/mediapipe/README.md.
 */
export function virtualBackgroundsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VIRTUAL_BACKGROUNDS !== "0";
}

/** Whether this browser can do it at all. WebGL2 and the WASM loader; an old Safari
 *  or a locked-down browser cannot, and the picker says so rather than failing on the
 *  first frame. Does not consult the kill switch — use `virtualBackgroundsEnabled`
 *  (or `backgroundsAvailable`) for that. */
export function backgroundsSupported(): boolean {
  if (typeof window === "undefined") return false;
  /* Asked once, and the answer kept.
   *
   * The check makes a WebGL context, and it used to run on every render of every screen that
   * shows a picker — the pre-join screen re-renders sixty times a second while its microphone
   * meter moves, so about a hundred and twenty contexts a second. A browser keeps about
   * sixteen live contexts and, asked for another, drops the one that has gone longest unused;
   * during start-up that is the one MediaPipe is waiting in for its model, and losing it is the
   * kGpuService failure presenters were shown (see keepWarm in lib/segmenter.ts). Measured,
   * the garbage collector kept up with these, and it took contexts held open to evict one, so
   * this alone was never shown to cause it. But every one counts until it is collected, and
   * asking twice tells us nothing new. The context is handed back straight away as well,
   * rather than left for the garbage collector, which is when it would otherwise be freed. */
  if (supported !== undefined) return supported;
  supported = probeSupport();
  return supported;
}

/** Kill switch on and this browser can run the effect path. */
export function backgroundsAvailable(): boolean {
  return virtualBackgroundsEnabled() && backgroundsSupported();
}

function probeSupport(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();

    /* WebGL2 is necessary and is not sufficient, which is what this check used to assume.
     *
     * Three things have to be true, and a browser can easily have the first without the
     * others — Safari 26 has no MediaStreamTrackProcessor at all, and Firefox had
     * canvas.captureStream for years before it had WebCodecs. Offering the picker on
     * WebGL2 alone meant those browsers were shown backgrounds and a brightness slider
     * that could not attach, and found out by having setProcessor throw
     * "Neither MediaStreamTrackProcessor nor canvas.captureStream() fallback is supported
     * in this browser" — worded for whoever wrote the library, not for a presenter three
     * minutes from going live.
     *
     * VideoFrame, because lib/segmenter.ts constructs one for every processed frame on
     * both paths, so it is required even where the wrapper needs nothing.
     *
     * Then a way to get frames in and out of a track: MediaStreamTrackProcessor with its
     * Generator, or the canvas.captureStream fallback. The condition mirrors the one inside
     * @livekit/track-processors deliberately — if this file is more optimistic than the
     * library it calls, the difference is a feature that appears to exist and then fails.
     */
    const w = window as unknown as Record<string, unknown>;
    if (typeof w.VideoFrame === "undefined") return false;
    const hasTrackProcessor =
      typeof w.MediaStreamTrackProcessor !== "undefined" &&
      typeof w.MediaStreamTrackGenerator !== "undefined";
    const hasCanvasFallback =
      typeof HTMLCanvasElement !== "undefined" &&
      "captureStream" in HTMLCanvasElement.prototype;
    return hasTrackProcessor || hasCanvasFallback;
  } catch {
    return false;
  }
}

const subscribeNever = () => () => {};
const unsupportedOnServer = () => false;

/** backgroundsSupported for a component: false on the server and in the first render,
 *  then the real answer, so hydration matches whatever this browser turns out to be. */
export function useBackgroundsSupported(): boolean {
  return useSyncExternalStore(subscribeNever, backgroundsSupported, unsupportedOnServer);
}

/** Build-time kill switch for components. Same on server and client (inlined at build). */
export function useVirtualBackgroundsEnabled(): boolean {
  return virtualBackgroundsEnabled();
}

/** Feature is enabled and this browser can run it. */
export function useBackgroundsAvailable(): boolean {
  return useVirtualBackgroundsEnabled() && useBackgroundsSupported();
}

type Wrapper = Pick<
  ProcessorWrapper<Record<string, unknown>>,
  "init" | "restart" | "destroy" | "processedTrack" | "source"
>;

/* The SoftSegmenter processor LiveKit is handed: the wrapper around our transformer, plus
 * what the wrapper does not do.
 *
 * It waits for a camera that is OFF. Turning the camera off in the room stops the device, and
 * the wrapper cannot start on a stopped track — the browser will not read one — so choosing a
 * background with the camera off used to fail outright, and turning the camera back on then
 * published the room. Given a stopped track, this does nothing yet: LiveKit restarts the
 * processor with the new camera as it comes back on, before it sends a frame of it, and that
 * is where it starts.
 *
 * It is how a screen recognises the processor another screen attached, so it can take it over
 * rather than build a second — see the file comment.
 *
 * And it knows whether starting it is what went wrong, which openCamera needs to know.
 */
class SoftBackgroundProcessor implements TrackProcessor<Track.Kind.Video> {
  readonly name = "soft-background";
  readonly soft: SoftSegmenter;
  private readonly inner: Wrapper;
  /** Set by openCamera, whose camera LiveKit opened for this processor. */
  opening = false;
  /** Whether starting it threw. */
  failedToStart = false;

  constructor(soft: SoftSegmenter, inner: Wrapper) {
    this.soft = soft;
    this.inner = inner;
  }

  get processedTrack(): MediaStreamTrack | undefined {
    return this.inner.processedTrack;
  }

  /** The camera it is processing, once it has started on one. */
  get source(): Wrapper["source"] {
    return this.inner.source;
  }

  async init(opts: VideoProcessorOptions): Promise<void> {
    if (opts.track.readyState === "ended") return;
    try {
      await this.inner.init(opts);
    } catch (err) {
      this.failedToStart = true;
      /* LiveKit drops a camera it opened for a processor that threw without stopping it, and
       * the light would stay on for a camera nobody holds. Only that one: any other camera
       * belongs to a track that is still showing it. */
      if (this.opening) opts.track.stop();
      throw err;
    }
  }

  async restart(opts: VideoProcessorOptions): Promise<void> {
    /* Onto a stopped track: let go of the old one, and wait as init does. LiveKit then sends
     * processedTrack, which is still the old output, stopped by the destroy; the camera it
     * would otherwise send is stopped too, so either way the audience is sent nothing, and
     * the next restart onto a live camera makes a new one. */
    if (opts.track.readyState === "ended") {
      await this.inner.destroy({ willProcessorRestart: true });
      return;
    }
    await this.inner.restart(opts);
  }

  async destroy(): Promise<void> {
    await this.inner.destroy();
    // The wrapper only passes a destroy on to a transformer that started.
    await this.soft.destroy();
  }
}

/* LiveKit's built-in BackgroundProcessor, wrapped the same way SoftBackgroundProcessor is
 * so openCamera / putOn / adopt share one shape. No SoftSegmenter, no low-light — switchTo
 * is how blur / image / off change without rebuilding the WASM. */
class LiveKitBackgroundAdapter implements TrackProcessor<Track.Kind.Video> {
  readonly name = "livekit-background";
  private readonly inner: BackgroundProcessorWrapper;
  opening = false;
  failedToStart = false;

  constructor(inner: BackgroundProcessorWrapper) {
    this.inner = inner;
  }

  get processedTrack(): MediaStreamTrack | undefined {
    return this.inner.processedTrack;
  }

  get source(): BackgroundProcessorWrapper["source"] {
    return this.inner.source;
  }

  async init(opts: VideoProcessorOptions): Promise<void> {
    if (opts.track.readyState === "ended") return;
    try {
      await this.inner.init(opts);
    } catch (err) {
      this.failedToStart = true;
      if (this.opening) opts.track.stop();
      throw err;
    }
  }

  async restart(opts: VideoProcessorOptions): Promise<void> {
    if (opts.track.readyState === "ended") {
      await this.inner.destroy({ willProcessorRestart: true });
      return;
    }
    await this.inner.restart(opts);
  }

  async destroy(): Promise<void> {
    await this.inner.destroy();
  }

  async applyChoice(choice: BackgroundChoice): Promise<void> {
    await this.inner.switchTo(liveKitSwitchFor(choice));
  }
}

type AnyBackgroundProcessor = SoftBackgroundProcessor | LiveKitBackgroundAdapter;

const softRetried = new WeakMap<SoftSegmenter, number>();
const liveKitRetried = new WeakMap<LiveKitBackgroundAdapter, number>();

/* A processor onto a camera that is already showing, without the preview blinking.
 *
 * setProcessor also moves every element showing the camera over to the processed track, and
 * the way it does that was the last blink on the pre-join screen. It takes the camera out of
 * each element's stream before putting the processed track in; a stream that goes empty is
 * taken off the element, and an element given a new stream shows nothing until that stream's
 * first frame. Measured, a frame or two of the bare tile, dark against a lit room — the first
 * time a background went on for a camera, and only then, since the processor stays attached
 * and every switch after it is a call on the one already there.
 *
 * So LiveKit is told not to, and the track is swapped inside the stream the element already
 * has. The element never stops playing, and goes from the camera's last frame to the
 * processor's first with nothing between them. Only where the wrapper's output is a
 * MediaStreamTrackGenerator — Chrome and Edge — which is where that was measured; elsewhere
 * it is a canvas capture, and LiveKit's own way is kept rather than guessed at.
 *
 * The swap itself waits for the processed track's first frame. setProcessor resolves when
 * the pipeline is wired, not when it has drawn; swapping then left the element on a
 * MediaStreamTrackGenerator that was still muted, which read as 1–2 black frames
 * (luma 0, readyState 0) on the pre-join probe. Keeping the camera in the stream until
 * unmute means the last live frame stays up until the first processed one is ready.
 *
 * Only an element still showing this camera, too. The pre-join screen reopens a camera into
 * the same element — another device chosen while this was attaching — and that element
 * belongs to the new track now; this one's output going into it would black out the preview.
 */
async function putOn(track: LocalVideoTrack, processor: AnyBackgroundProcessor): Promise<void> {
  const inPlace =
    "MediaStreamTrackProcessor" in globalThis && "MediaStreamTrackGenerator" in globalThis;
  await track.setProcessor(processor, !inPlace);
  const camera = processor.source;
  const processed = processor.processedTrack;
  if (!inPlace || !camera || !processed) return;
  await whenTrackHasFrame(processed);
  for (const element of track.attachedElements) {
    const stream = element.srcObject;
    if (!(stream instanceof MediaStream) || !stream.getVideoTracks().includes(camera)) continue;
    stream.addTrack(processed);
    stream.removeTrack(camera);
  }
}

/** Resolves once `track` has produced a frame, or after a short timeout.
 *
 * MediaStreamTrackGenerator starts muted and fires unmute on the first frame. Without
 * waiting, putOn would hand the element a live-looking track that still has nothing to
 * paint. */
function whenTrackHasFrame(track: MediaStreamTrack, ms = 1000): Promise<void> {
  if (!track.muted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      track.removeEventListener("unmute", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    track.addEventListener("unmute", done);
  });
}

/**
 * True when setProcessor failed because the camera was stopped underneath it — not a
 * real background failure, so the Retry alert must not mount.
 *
 * Exported for the unit test: the sentence is LiveKit's, and matching it is what stops a
 * camera switch from looking like "Couldn't start the background".
 */
export function isBackgroundAttachAbort(err: unknown, trackEnded = false): boolean {
  if (trackEnded) return true;
  return /input track cannot be ended/i.test(errorText(err));
}

/** A processor's status, published for every screen that shows it; see BackgroundStatus.
 *  `lowLightOnly` words a failure for the lift rather than for a background nobody chose. */
function reportStatus(lowLightOnly: boolean): (next: SegmenterStatus) => void {
  return (next) => {
    if (next.phase === "failed") {
      publishStatus({
        phase: "failed",
        error: describeBackgroundError(next.error, lowLightOnly),
        retryable: true,
      });
    } else {
      publishStatus({ phase: next.phase, error: null, retryable: false });
    }
  };
}

/* LiveKit BackgroundProcessor mode options for a choice. */
function liveKitSwitchFor(
  choice: BackgroundChoice,
):
  | { mode: "disabled" }
  | { mode: "background-blur"; blurRadius: number }
  | { mode: "virtual-background"; imagePath: string } {
  if (choice.mode === "blur") {
    return { mode: "background-blur", blurRadius: BLUR_RADIUS };
  }
  if (choice.mode === "image") {
    const item = VIRTUAL_BACKGROUNDS.find((b) => b.id === choice.id);
    return item
      ? { mode: "virtual-background", imagePath: item.src }
      : { mode: "background-blur", blurRadius: BLUR_RADIUS };
  }
  return { mode: "disabled" };
}

/* SoftSegmenter + ProcessorWrapper ("enhanced" engine).
 *
 * Imported here rather than at the top of the file: between them these two modules pull in
 * MediaPipe's WASM, and an attendee who never opens the picker should not pay for it in their
 * bundle.
 *
 * ProcessorWrapper is @livekit/track-processors' plumbing — the MediaStreamTrackProcessor
 * wiring, the canvas.captureStream fallback for browsers without it, and the LiveKit
 * TrackProcessor interface. That part is good and there is no reason to rewrite it. What is
 * replaced is the transformer inside: see lib/segmenter.ts for why.
 */
async function createSoftProcessor(
  choice: BackgroundChoice,
  lowLight: number,
  listeners: Pick<SegmenterOptions, "onFrame" | "onStatus">,
): Promise<SoftBackgroundProcessor> {
  /* SoftSegmenter first, then ProcessorWrapper — not in parallel.
   *
   * `@livekit/track-processors` statically imports `@mediapipe/tasks-vision` for its unused
   * BackgroundTransformer. SoftSegmenter loads the same package for real. Two copies of the
   * Emscripten glue (0.10.14 nested under track-processors, 1.0.1 at the top level) sharing
   * one vendored `/mediapipe/wasm` was a second path to "callbacks.shift(...) is not a
   * function" that oneAtATime alone could not cover: module evaluation itself was racing.
   * npm overrides pin a single version; loading them one after the other keeps evaluation
   * ordered even if a bundler still emits two chunks. */
  const { SoftSegmenter } = await import("./segmenter");
  const { ProcessorWrapper } = await import("@livekit/track-processors");
  const soft = new SoftSegmenter({
    background: backgroundFor(choice),
    lowLight: lowLightAmount(lowLight),
    ...listeners,
  });
  softRetried.set(soft, status.attempt);
  return new SoftBackgroundProcessor(soft, new ProcessorWrapper(soft as never, "soft-background"));
}

/* LiveKit's built-in BackgroundProcessor ("livekit" engine).
 *
 * Same package as ProcessorWrapper — npm `@livekit/track-processors` (repo track-processors-js).
 * Points assetPaths at our vendored MediaPipe so corporate CDNs are not required. No low-light.
 */
async function createLiveKitProcessor(
  choice: BackgroundChoice,
  listeners: { onFrame?: SegmenterOptions["onFrame"] },
): Promise<LiveKitBackgroundAdapter> {
  const { BackgroundProcessor } = await import("@livekit/track-processors");
  const mode = liveKitSwitchFor(choice);
  const inner = BackgroundProcessor(
    {
      ...mode,
      assetPaths: {
        tasksVisionFileSet: MEDIAPIPE_WASM,
        modelAssetPath: MEDIAPIPE_MODEL,
      },
      onFrameProcessed: listeners.onFrame
        ? (stats) => {
            listeners.onFrame!({
              totalMs: stats.processingTimeMs,
              segmentMs: stats.segmentationTimeMs,
            });
          }
        : undefined,
    },
    "livekit-background",
  );
  const adapter = new LiveKitBackgroundAdapter(inner);
  liveKitRetried.set(adapter, status.attempt);
  return adapter;
}

async function createProcessor(
  engine: BackgroundEngine,
  choice: BackgroundChoice,
  lowLight: number,
  listeners: Pick<SegmenterOptions, "onFrame" | "onStatus">,
): Promise<AnyBackgroundProcessor> {
  if (engine === "livekit") {
    return createLiveKitProcessor(choice, { onFrame: listeners.onFrame });
  }
  return createSoftProcessor(choice, lowLight, listeners);
}

/** Drop whatever processor is on the track so the other engine can attach cleanly. */
async function detachProcessor(track: LocalVideoTrack): Promise<void> {
  if (!track.getProcessor()) return;
  await track.stopProcessor().catch(() => {});
}

/**
 * Opens the camera with the background already on it.
 *
 * `open` is whatever opens the camera on this screen — createLocalVideoTrack on the pre-join
 * screen, setCameraEnabled in the room — handed the processor to open it with, or nothing.
 * LiveKit attaches the processor before it returns the track, so the first frame anybody sees
 * is processed; see the file comment.
 *
 * A failed enhancement must not cost somebody their camera. If starting the processor is what
 * failed, the camera is opened again without it, and useVirtualBackground's attach has another
 * go and says why if it cannot. Anything else — a refused permission, a camera in use — is the
 * camera's own failure, and goes back to the caller as it was.
 *
 * `engine` picks SoftSegmenter vs LiveKit's BackgroundProcessor. Low-light is ignored on the
 * LiveKit engine (that API has no lift).
 */
export async function openCamera<T>(
  choice: BackgroundChoice,
  lowLight: number,
  open: (processor?: TrackProcessor<Track.Kind.Video>) => Promise<T>,
  engine: BackgroundEngine = DEFAULT_BACKGROUND_ENGINE,
): Promise<T> {
  const effectiveLowLight = engine === "livekit" ? 0 : lowLight;
  if (
    (choice.mode === "none" && asLowLight(effectiveLowLight) === 0) ||
    !backgroundsAvailable()
  ) {
    return open();
  }

  /* Publish the in-flight open before any await, so useVirtualBackground's effect
   * waits on `openingCamera` rather than building a second SoftSegmenter while
   * LiveKit is still inside setProcessor (getProcessor is unset until init finishes). */
  const prior = openingCamera;
  const work = (async (): Promise<T> => {
    await prior?.catch(() => {});
    let processor: AnyBackgroundProcessor;
    try {
      processor = await createProcessor(engine, choice, effectiveLowLight, {
        onStatus: reportStatus(choice.mode === "none"),
      });
    } catch (err) {
      // The code did not arrive. The camera opens as it is, and the attach says why.
      console.warn("[background] couldn't load; opening the camera without it", err);
      return open();
    }

    processor.opening = true;
    try {
      return await open(processor);
    } catch (err) {
      await processor.destroy().catch(() => {});
      if (!processor.failedToStart) throw err;
      console.error("[background] failed to start", err, {
        mode: choice.mode,
        image: choice.mode === "image" ? choice.id : null,
        lowLight: asLowLight(effectiveLowLight),
        engine,
        while: "opening the camera",
      });
      return open();
    } finally {
      processor.opening = false;
    }
  })();

  openingCamera = work;
  void work.finally(() => {
    if (openingCamera === work) openingCamera = null;
  });
  return work;
}

/**
 * Turns the camera on in the room, with the background already on it.
 *
 * The first time, that is openCamera. After it the camera stays published while it is off, and
 * LiveKit restarts the processor on it as it comes back on, before it sends a frame — so all
 * there is to do is wait for an attach still on its way. That includes one made while the
 * camera was off, which is waiting for exactly this; see SoftBackgroundProcessor.
 */
export async function enableCamera(
  participant: LocalParticipant,
  choice: BackgroundChoice,
  lowLight: number,
  engine: BackgroundEngine = DEFAULT_BACKGROUND_ENGINE,
): Promise<void> {
  const camera = participant.getTrackPublication("camera" as Track.Source)?.track;
  if (camera) {
    await attaching.get(camera as LocalVideoTrack)?.catch(() => {});
    await participant.setCameraEnabled(true);
    return;
  }
  await openCamera(
    choice,
    lowLight,
    (processor) => participant.setCameraEnabled(true, processor ? { processor } : undefined),
    engine,
  );
}

/**
 * Applies a background (and, on the Enhanced engine, a low-light lift) to a camera track.
 *
 * On Enhanced, both ride one GPU pass: the compositor already has the person's pixels in a
 * register to blend them over a background; lifting them there costs an instruction.
 * LiveKit's BackgroundProcessor has no low-light API, so that engine ignores `lowLight`.
 *
 * The track changes underneath this: stopping and starting the camera republishes it,
 * switching camera device replaces it, and a promoted attendee gets one for the first
 * time mid-session. Keying the effect on the track's sid means each of those re-applies
 * the processor rather than leaving somebody's room on show.
 *
 * Switching `engine` tears down one processor and attaches the other — the transformers
 * are not interchangeable.
 *
 * `onDegraded` fires when the device cannot keep up. The caller says so and turns it
 * off — this hook does not decide that on its own, because "your laptop is too slow"
 * is a sentence that belongs to the UI.
 */
export function useVirtualBackground(
  track: LocalVideoTrack | undefined,
  choice: BackgroundChoice,
  /** The low-light lift in stored units, 0..LOW_LIGHT_MAX. 0 is off. Ignored on LiveKit. */
  lowLight: number,
  onDegraded?: () => void,
  engine: BackgroundEngine = DEFAULT_BACKGROUND_ENGINE,
) {
  const softCurrent = useRef<SoftSegmenter | null>(null);
  const liveKitCurrent = useRef<LiveKitBackgroundAdapter | null>(null);
  const shown = useBackgroundStatus();

  /* The latest amount, for the attach path to read at the moment it builds the
   * transformer. Attaching is async, so the value can move between the effect starting
   * and the processor existing — and the push effect below cannot cover that window,
   * because there is nothing to push to yet. */
  const latestLowLight = useRef(lowLight);
  useEffect(() => {
    latestLowLight.current = lowLight;
  }, [lowLight]);

  // The slow-frame window, reset whenever the mode changes.
  const slow = useRef({ frames: 0, slowFrames: 0, totalMs: 0, segmentMs: 0 });
  const degraded = useRef(false);

  // Through a ref so the effect below does not re-run when the caller re-renders.
  const notifyDegraded = useRef(onDegraded);
  useEffect(() => {
    notifyDegraded.current = onDegraded;
  }, [onDegraded]);

  /* Whether this screen is still here. The processor outlives it — it goes on to the room —
   * and until the room takes it over it would otherwise go on reporting slow frames to a
   * pre-join screen that has gone, which would turn the background off with nobody told. */
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const sid = track?.sid ?? track?.mediaStreamID;
  /* Whether the lift is on, NOT how much. LiveKit has no lift — treat as off there.
   *
   * The amount must not be in this key. It changes on every pixel of a slider drag, and
   * this key drives the attach effect — so including it would re-enter that effect thirty
   * times on the way from 0 to 60 for nothing. Whether there is anything to attach AT ALL
   * is all this needs, and the amount goes in through setLowLight. */
  const lit = engine !== "livekit" && asLowLight(lowLight) > 0;
  const key =
    `${engine}:` +
    (choice.mode === "image" ? `image:${choice.id}` : choice.mode) +
    (lit ? "+lit" : "");
  const attempt = shown.attempt;

  /* Fetch the module before there is a track to apply it to.
   *
   * Started as soon as a background is known to be wanted, so by the time the track exists
   * the code is usually in the bundler's cache and attaching starts at once. Deliberately not
   * awaited and deliberately not reported. It is a head start, not a step — if it fails, the
   * real import below fails too and says so there.
   */
  useEffect(() => {
    if ((choice.mode === "none" && !lit) || !backgroundsAvailable()) return;
    if (engine === "livekit") {
      void import("@livekit/track-processors").catch(() => {});
      return;
    }
    // Same order as createSoftProcessor: SoftSegmenter's module before track-processors'.
    void import("./segmenter")
      .then(() => import("@livekit/track-processors"))
      .catch(() => {});
  }, [choice.mode, engine, lit]);

  useEffect(() => {
    if (!track) {
      // No camera, so nothing to be preparing or to have failed at. A failure from the last
      // track would otherwise sit under a picker that says to start the camera first.
      softCurrent.current = null;
      liveKitCurrent.current = null;
      publishStatus({ phase: "idle", error: null, retryable: false });
      return;
    }
    let cancelled = false;
    const background = backgroundFor(choice);
    const lowLightOnly = choice.mode === "none";
    /* Kill-switched prefs may still hold blur/low-light from an earlier build; ignore
     * them rather than attaching or reporting a fake WebGL2 failure. */
    const wanted = virtualBackgroundsEnabled() && (choice.mode !== "none" || lit);

    const onFrame = ({ totalMs, segmentMs }: { totalMs: number; segmentMs: number }) => {
      if (!mounted.current) return;
      const w = slow.current;
      w.frames += 1;
      w.totalMs += totalMs;
      w.segmentMs += segmentMs;
      if (totalMs > SLOW_FRAME_MS) w.slowFrames += 1;
      if (w.frames < SLOW_FRAME_WINDOW) return;

      // Averaged over the window rather than reported per frame: a number
      // that changes thirty times a second cannot be read.
      publishFrameCost({
        total: Math.round((w.totalMs / w.frames) * 10) / 10,
        segment: Math.round((w.segmentMs / w.frames) * 10) / 10,
      });

      const tooSlow = (w.slowFrames / w.frames) * 100 > SLOW_FRAME_LIMIT;
      w.frames = 0;
      w.slowFrames = 0;
      w.totalMs = 0;
      w.segmentMs = 0;
      // Announced once. Repeating it every ninety frames would be a toast
      // storm on exactly the device least able to cope with one.
      if (tooSlow && !degraded.current) {
        degraded.current = true;
        notifyDegraded.current?.();
      }
    };

    const onStatus = reportStatus(lowLightOnly);

    /* Taking over a SoftSegmenter that is already on the track — this screen's from a moment
     * ago, the pre-join screen's, or the one the camera was opened with. Everything is a call
     * on it: no await, no rebuild, and the next frame out is the new choice. The status
     * listener goes on last, so the first thing it reports is where the processor is after
     * all of that, not before. */
    const adoptSoft = (soft: SoftSegmenter) => {
      softCurrent.current = soft;
      liveKitCurrent.current = null;
      soft.setOnFrame(onFrame);
      soft.setBackground(background);
      soft.setLowLight(lowLightAmount(latestLowLight.current));
      if ((softRetried.get(soft) ?? attempt) !== attempt) soft.retry();
      softRetried.set(soft, attempt);
      soft.setOnStatus(onStatus);
      if (!wanted) publishFrameCost(null);
    };

    const adoptLiveKit = async (adapter: LiveKitBackgroundAdapter) => {
      softCurrent.current = null;
      liveKitCurrent.current = adapter;
      if ((liveKitRetried.get(adapter) ?? attempt) !== attempt) {
        // Retry: tear down and let the attach path rebuild.
        await detachProcessor(track);
        liveKitCurrent.current = null;
        return false;
      }
      liveKitRetried.set(adapter, attempt);
      if (!track.isMuted) publishStatus({ phase: "preparing", error: null, retryable: false });
      try {
        await adapter.applyChoice(choice);
        if (!cancelled) {
          publishStatus({
            phase: wanted ? "ready" : "idle",
            error: null,
            retryable: false,
          });
          if (!wanted) publishFrameCost(null);
        }
      } catch (err) {
        if (cancelled) return true;
        publishFrameCost(null);
        publishStatus({
          phase: "failed",
          error: describeBackgroundError(err, lowLightOnly),
          retryable: true,
        });
      }
      return true;
    };

    (async () => {
      // One on the way is waited for and then adopted, never raced. See `attaching`
      // and `openingCamera` — openCamera has no track key until open() returns.
      await openingCamera?.catch(() => {});
      if (cancelled) return;
      await attaching.get(track)?.catch(() => {});
      if (cancelled) return;

      const existing = track.getProcessor();

      if (engine === "enhanced" && existing instanceof SoftBackgroundProcessor) {
        adoptSoft(existing.soft);
        return;
      }
      if (engine === "livekit" && existing instanceof LiveKitBackgroundAdapter) {
        const kept = await adoptLiveKit(existing);
        if (cancelled || kept) return;
        // Retry fell through — rebuild below.
      } else if (existing) {
        // Wrong engine (or an unknown processor): tear down before building the other.
        await detachProcessor(track);
        if (cancelled) return;
      }

      softCurrent.current = null;
      liveKitCurrent.current = null;

      /* Nothing to do, and nothing to load: a participant who never turns a background on
       * never downloads nine megabytes of WASM. Once one has been attached it stays, set
       * to pass frames through — taking it off would be a black frame for the audience,
       * and putting it back another. */
      if (!wanted) {
        publishFrameCost(null);
        publishStatus({ phase: "idle", error: null, retryable: false });
        return;
      }

      if (!backgroundsSupported()) {
        // Both need WebGL2, and the sentence has to name the one being asked for:
        // "can't run virtual backgrounds" over a brightness slider reads as a
        // different feature failing.
        publishStatus({
          phase: "failed",
          error: lowLightOnly
            ? "This browser can't adjust your video. It needs WebGL2."
            : "This browser can't run virtual backgrounds.",
          retryable: false,
        });
        return;
      }

      /* Announced before the first await, so the very first paint after the click already
       * says something is happening. Anything later and the gap this exists to explain is
       * the gap it fails to cover. Not for a camera that is off, where the processor waits
       * for it to come back on and there is nothing to prepare yet. */
      if (!track.isMuted) publishStatus({ phase: "preparing", error: null, retryable: false });
      const hadProcessor = existing !== undefined;

      const attach = (async () => {
        const created = await createProcessor(engine, choice, latestLowLight.current, {
          onFrame,
          onStatus,
        });
        try {
          await putOn(track, created);
        } catch (err) {
          /* A failed enhancement must not cost somebody their camera.
           *
           * setProcessor can throw with the processor half-attached, and a half-attached
           * processor goes on feeding the track from a canvas that is not rendering. That
           * reaches the preview as a BLACK RECTANGLE rather than as an error: the camera
           * toggle still says on, the light on the machine is still lit, and nothing on the
           * screen connects the dark square to the brightness slider that caused it.
           *
           * So it comes back off: off the track if it made it on, and destroyed regardless. */
          if (track.getProcessor() === created) await track.stopProcessor().catch(() => {});
          await created.destroy().catch(() => {});
          throw err;
        }
        /* Stopped while it was attaching. LiveKit destroys the processor on stop, but only
         * one it already knew about — and until init finished it did not know about this
         * one, so without this it would hold its GPU context until the tab closed. */
        if ((track as unknown as { manuallyStopped?: boolean }).manuallyStopped) {
          await created.destroy().catch(() => {});
        }
        return created;
      })();
      attaching.set(track, attach);

      try {
        const created = await attach;
        /* Taken over as though it had been found there, for what moved while it attached —
         * the slider, a Retry — and for one waiting on a camera that is off, which has
         * started nothing yet. Given the choice now, it loads the model while it waits, so
         * the camera comes on to the background rather than to a blur while that happens. */
        if (cancelled) return;
        if (created instanceof SoftBackgroundProcessor) {
          adoptSoft(created.soft);
        } else {
          liveKitCurrent.current = created;
          // LiveKit has no onStatus from the transformer; attach success is "ready".
          // applyChoice covers a choice that moved while we were attaching.
          await created.applyChoice(choice).catch(() => {});
          if (!cancelled) {
            publishStatus({ phase: "ready", error: null, retryable: false });
          }
        }
      } catch (err) {
        /* Not a failure. The camera it was starting on was stopped underneath it — another
         * device chosen, or the camera turned off — and the screen that stopped it is moving
         * on to whatever replaced it. The wrapper says so as "Input track cannot be ended",
         * which landed in the console as "[background] failed to start" with a stack (that
         * part was measured). Without this return the catch below would also publish a
         * failed status, which is what mounts the Retry alert — whether that box itself
         * appeared on the old path was not measured. Not `cancelled`: that is set by the
         * re-render, which can come after this.
         *
         * Match the error text as well as LiveKit's flag: setProcessor can reject with
         * that sentence before manuallyStopped is visible on this wrapper, and publishing
         * it as a real failure is the generic Retry box over a raw camera. */
        if (
          isBackgroundAttachAbort(
            err,
            !!(track as unknown as { manuallyStopped?: boolean }).manuallyStopped ||
              track.mediaStreamTrack?.readyState === "ended",
          )
        ) {
          return;
        }

        /* The whole error, not just its sentence.
         *
         * The sentence is what a presenter can be shown and is nowhere near enough to act
         * on. "callbacks.shift(...) is not a function" is a real example: that string appears
         * in three vendored WASM runtimes and in no source file, so the message alone cannot
         * say which module threw, at which stage, or on which of the two copies of MediaPipe
         * this bundle contains. Thirteen cold-start scenarios in
         * e2e/probe-segmenter-init.mjs failed to reproduce it, which is exactly the situation
         * where the stack is worth more than any amount of further guessing.
         *
         * console.error rather than a telemetry call, because the error object goes to the
         * console intact and the browser expands the frames. Whoever hits it can screenshot
         * that, and the answer is in it.
         */
        console.error("[background] failed to start", err, {
          mode: choice.mode,
          image: choice.mode === "image" ? choice.id : null,
          lowLight: asLowLight(lowLight),
          engine,
          trackId: sid ?? null,
          hadProcessor: hadProcessor,
        });
        if (cancelled) return;
        publishFrameCost(null);
        publishStatus({
          phase: "failed",
          error: describeBackgroundError(err, lowLightOnly),
          retryable: true,
        });
      } finally {
        if (attaching.get(track) === attach) attaching.delete(track);
      }
    })();

    return () => {
      cancelled = true;
    };
    // sid, so republishing the camera re-applies it. key, so changing the choice or engine
    // switches it. attempt, so Retry retries. The track object itself is deliberately
    // not a dependency: LiveKit hands back a new wrapper on every render for the same
    // underlying track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, key, attempt]);

  /* The amount, straight into the SoftSegmenter that is already running.
   *
   * A uniform write, not a restart — see SoftSegmenter.setLowLight. Nothing is awaited
   * and nothing is torn down, so dragging the slider is smooth and the published track
   * never drops a frame. A no-op before the processor exists, or on the LiveKit engine.
   */
  useEffect(() => {
    if (engine === "livekit") return;
    softCurrent.current?.setLowLight(lowLightAmount(lowLight));
  }, [lowLight, engine]);

  // The window and the one-shot warning both reset when the mode changes, so a
  // lighter background gets a fair hearing on a device that failed with a heavier one.
  useEffect(() => {
    slow.current = { frames: 0, slowFrames: 0, totalMs: 0, segmentMs: 0 };
    degraded.current = false;
  }, [key]);

  /* Deliberately no teardown on unmount. The processor is the track's, and goes when the
   * track is stopped — LiveKit destroys it then. Destroying it here was what made joining
   * a webinar a flash of the raw room and a second model load: the pre-join screen
   * unmounts as the room takes over the very track it was processing. */

  return {
    error: shown.phase === "failed" ? shown.error : null,
    retryable: shown.phase === "failed" && shown.retryable,
    preparing: shown.phase === "preparing",
    retry: retryBackground,
  };
}
