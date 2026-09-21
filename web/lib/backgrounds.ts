"use client";

import type { LocalVideoTrack } from "livekit-client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Background } from "./segmenter";

/* Virtual backgrounds: off, blur, or a bundled image.
 *
 * The pipeline is MediaPipe's selfie segmenter behind @livekit/track-processors: every
 * frame goes camera → segmentation → alpha matte → composite over the chosen
 * background → canvas.captureStream(), and the processed stream replaces the published
 * track. Written by hand this is a WebGL program and a WASM loader; the processor does
 * it and plugs into LocalVideoTrack.setProcessor, which is the only reason this file is
 * three hundred lines rather than three thousand.
 *
 * Two decisions worth stating:
 *
 * The model is served from THIS origin. The processor defaults to fetching its WASM
 * from jsdelivr and the .tflite from googleapis, and both are routinely blocked on
 * corporate networks — the ones a webinar audience sits behind. A background that
 * silently fails to load for a quarter of the room is worse than one that is not
 * offered, so the assets are vendored into public/mediapipe (see the README) and
 * pointed at explicitly.
 *
 * The processor is created once and SWITCHED. Tearing it down and rebuilding it to change
 * mode re-initialises the WASM and drops frames on the way through — visible to the
 * audience as a stutter. `switchTo` changes the mode in place.
 */

// ------------------------------------------------------------------ the catalogue

export type BackgroundMode = "none" | "blur" | "image";

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

/** How hard to blur. High enough that a room is unreadable, low enough that the
 *  segmentation edge does not become the most interesting thing on screen. */
const BLUR_RADIUS = 12;

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

type Processor = {
  setBackground: (background: Background) => Promise<void>;
  setLowLight: (amount: number) => void;
  destroy: () => Promise<void>;
};

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

/** Whether this browser can do it at all. WebGL2 and the WASM loader; an old Safari
 *  or a locked-down browser cannot, and the picker says so rather than failing on the
 *  first frame. */
export function backgroundsSupported(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // Loaded lazily elsewhere; this check is synchronous and cheap.
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * Applies a background and a low-light lift to a camera track, and keeps applying them.
 *
 * Both, from one hook, because they are one GPU pass. The compositor already has the
 * person's pixels in a register to blend them over a background; lifting them there costs
 * an instruction, and doing it in a second processor would mean a second WebGL context, a
 * second canvas.captureStream and a second frame of latency for something that is four
 * lines of shader. The name stayed `useVirtualBackground` for the same reason it is not
 * two processors: this is where the pass is.
 *
 * The track changes underneath this: stopping and starting the camera republishes it,
 * switching camera device replaces it, and a promoted attendee gets one for the first
 * time mid-session. Keying the effect on the track's sid means each of those re-applies
 * the processor rather than leaving somebody's room on show.
 *
 * `onDegraded` fires when the device cannot keep up. The caller says so and turns it
 * off — this hook does not decide that on its own, because "your laptop is too slow"
 * is a sentence that belongs to the UI.
 */
export function useVirtualBackground(
  track: LocalVideoTrack | undefined,
  choice: BackgroundChoice,
  /** The low-light lift in stored units, 0..LOW_LIGHT_MAX. 0 is off. */
  lowLight: number,
  onDegraded?: () => void,
) {
  const processor = useRef<Processor | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const sid = track?.sid ?? track?.mediaStreamID;
  /* Whether the lift is on, NOT how much.
   *
   * The amount must not be in this key. It changes on every pixel of a slider drag, and
   * this key drives the attach/detach effect — so including it would tear the processor
   * down and stand it back up thirty times on the way from 0 to 60, which the audience
   * sees as a stutter. Whether there is anything to attach AT ALL is all this needs, and
   * the amount goes in through setLowLight. */
  const lit = asLowLight(lowLight) > 0;
  const key =
    (choice.mode === "image" ? `image:${choice.id}` : choice.mode) +
    (lit ? "+lit" : "");

  /* Fetch the model before there is a track to apply it to.
   *
   * Without this the nine megabytes of WASM start downloading when the camera comes up,
   * which is the one moment they must not: the raw camera is already published and the
   * room is on screen for however long the download takes. Started as soon as a
   * background is known to be wanted, so by the time the track exists the module is
   * usually in the bundler's cache and attaching is immediate.
   *
   * Deliberately not awaited and deliberately not reported. It is a head start, not a
   * step — if it fails, the real import below fails too and says so there.
   */
  useEffect(() => {
    if (choice.mode === "none" || !backgroundsSupported()) return;
    void import("./segmenter").catch(() => {});
  }, [choice.mode]);

  useEffect(() => {
    if (!track) return;
    let cancelled = false;

    (async () => {
      // Nothing to do, and nothing to load: a participant who never turns a
      // background on never downloads nine megabytes of WASM.
      if (choice.mode === "none" && !lit) {
        publishFrameCost(null);
        if (processor.current) {
          try {
            await track.stopProcessor();
          } catch {
            // The track may already be gone. Not worth reporting.
          }
          await processor.current.destroy().catch(() => {});
          processor.current = null;
        }
        return;
      }

      if (!backgroundsSupported()) {
        // Both need WebGL2, and the sentence has to name the one being asked for:
        // "can't run virtual backgrounds" over a brightness slider reads as a
        // different feature failing.
        setError(
          choice.mode === "none"
            ? "This browser can't adjust your video. It needs WebGL2."
            : "This browser can't run virtual backgrounds.",
        );
        return;
      }

      try {
        if (!processor.current) {
          /* Imported here rather than at the top of the file: between them these two
           * modules pull in MediaPipe's WASM, and an attendee who never opens the
           * picker should not pay for it in their bundle.
           *
           * ProcessorWrapper is @livekit/track-processors' plumbing — the
           * MediaStreamTrackProcessor wiring, the canvas.captureStream fallback for
           * browsers without it, and the LiveKit TrackProcessor interface. That part
           * is good and there is no reason to rewrite it. What is replaced is the
           * transformer inside: see lib/segmenter.ts for why. */
          const [{ ProcessorWrapper }, { SoftSegmenter }] = await Promise.all([
            import("@livekit/track-processors"),
            import("./segmenter"),
          ]);
          if (cancelled) return;

          const transformer = new SoftSegmenter({
            background: backgroundFor(choice),
            lowLight: lowLightAmount(latestLowLight.current),
            onFrame: ({ totalMs, segmentMs }) => {
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
            },
          });

          const wrapper = new ProcessorWrapper(transformer as never, "soft-background");
          const created: Processor = {
            setBackground: (background) => transformer.setBackground(background),
            setLowLight: (amount) => transformer.setLowLight(amount),
            destroy: () => wrapper.destroy(),
          };

          if (cancelled) {
            await created.destroy().catch(() => {});
            return;
          }
          processor.current = created;
          // Again, after assignment: the slider may have moved while the import above
          // was in the air, and until this line there was nothing for the push effect
          // below to write to.
          created.setLowLight(lowLightAmount(latestLowLight.current));
          await track.setProcessor(wrapper as never);
        } else {
          // Changed in place rather than rebuilt: recreating drops frames while the
          // WASM re-initialises, and the audience sees the stutter.
          await processor.current.setBackground(backgroundFor(choice));
          processor.current.setLowLight(lowLightAmount(latestLowLight.current));
        }
        if (!cancelled) setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? `Couldn't start the background: ${err.message}`
            : "Couldn't start the background.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // sid, so republishing the camera re-applies it. key, so changing the choice
    // switches it. The track object itself is deliberately not a dependency: LiveKit
    // hands back a new wrapper on every render for the same underlying track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, key]);

  /* The amount, straight into the processor that is already running.
   *
   * A uniform write, not a restart — see SoftSegmenter.setLowLight. Nothing is awaited
   * and nothing is torn down, so dragging the slider is smooth and the published track
   * never drops a frame. A no-op before the processor exists, which is fine: the attach
   * path reads the same ref when it builds one.
   */
  useEffect(() => {
    processor.current?.setLowLight(lowLightAmount(lowLight));
  }, [lowLight]);

  // The window and the one-shot warning both reset when the mode changes, so a
  // lighter background gets a fair hearing on a device that failed with a heavier one.
  useEffect(() => {
    slow.current = { frames: 0, slowFrames: 0, totalMs: 0, segmentMs: 0 };
    degraded.current = false;
  }, [key]);

  // Torn down on unmount, not on every dependency change: leaving the WASM and its
  // GPU textures alive after somebody leaves the room is a leak that survives until
  // the tab closes.
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
