"use client";

import { Track, type LocalParticipant, type LocalTrackPublication } from "livekit-client";
import { useEffect, useRef, useState } from "react";
import { type ShareSurface } from "./own-share-surface";

export {
  formatElapsed,
  shareSurface,
  wantsPresenterView,
  type ShareSurface,
} from "./own-share-surface";
import { shareSurface } from "./own-share-surface";

/* What the presenter is sharing, so they can see it.
 *
 * Sharing a Chrome tab already shows you what you share: Chrome switches to that tab and
 * draws its own bar. Sharing a WINDOW or the ENTIRE SCREEN left you on the webinar page with
 * "You're sharing your screen" and nothing else — no idea what the audience was looking at.
 *
 * This file is the facts the presenter's UI is built from:
 *
 *   surface    "browser" (a tab), "window", or "monitor" (the entire screen), as the browser
 *              reports it in the capture's own settings. Null when it does not say.
 *   startedAt  when our share was published, for the elapsed timer.
 *   frozen     the captured surface stopped sending pictures — a minimized window is the
 *              common case — which the browser reports by muting the capture track.
 *
 * And two things that cannot be done in a browser, so nobody tries again:
 *   - a border around the shared window, like Zoom's green one. A page cannot draw outside
 *     its own tab; the browser's "is sharing" bar and the OS indicator are what there is.
 *   - knowing the shared window's NAME. The capture track's label is an opaque id.
 */

export type OwnShare = {
  surface: ShareSurface | null;
  /** The capture itself. Null while not sharing. */
  track: MediaStreamTrack | null;
  /** Date.now() when our share was published. */
  startedAt: number | null;
  /** The captured surface stopped sending pictures (minimized, or hidden by the OS). */
  frozen: boolean;
};

const IDLE: OwnShare = { surface: null, track: null, startedAt: null, frozen: false };

/* When each capture started, shared by everything that asks. The stage tile and the control
 * bar both read our share, and the tile remounts with the layout — each keeping its own
 * clock would show two timers that disagree, and one that restarts on a layout change. */
const startedAtByTrack = new WeakMap<MediaStreamTrack, number>();
function startedAtOf(track: MediaStreamTrack): number {
  let at = startedAtByTrack.get(track);
  if (at === undefined) {
    at = Date.now();
    startedAtByTrack.set(track, at);
  }
  return at;
}

/**
 * Our own live screen share, as the facts above. A shared video FILE is excluded by the
 * caller (it publishes on the same source, but there is no surface to show).
 *
 * `onEnded` fires when the browser ended the capture on its own — the shared window was
 * closed, or "Stop sharing" was pressed in the browser's own bar. Our own Stop does not fire
 * it: MediaStreamTrack.stop() never dispatches `ended`, which is exactly the distinction.
 */
export function useOwnShare(
  participant: LocalParticipant | undefined,
  onEnded?: (surface: ShareSurface | null) => void,
): OwnShare {
  const [state, setState] = useState<OwnShare>(IDLE);
  /* Through a ref so a new handler identity per render does not re-subscribe, which would
   * reset startedAt mid-share. */
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    if (!participant) return;
    let watched: MediaStreamTrack | null = null;
    let detach: (() => void) | null = null;

    const read = () => {
      const pub = participant.getTrackPublication(Track.Source.ScreenShare) as
        | LocalTrackPublication
        | undefined;
      const track = pub?.track?.mediaStreamTrack ?? null;
      if (track === watched) return;
      detach?.();
      detach = null;
      watched = track;
      if (!track) {
        setState(IDLE);
        return;
      }
      const surface = shareSurface(track);
      setState({ surface, track, startedAt: startedAtOf(track), frozen: track.muted });
      const onMute = () => setState((s) => (s.track === track ? { ...s, frozen: true } : s));
      const onUnmute = () => setState((s) => (s.track === track ? { ...s, frozen: false } : s));
      const onEnd = () => onEndedRef.current?.(surface);
      track.addEventListener("mute", onMute);
      track.addEventListener("unmute", onUnmute);
      track.addEventListener("ended", onEnd);
      detach = () => {
        track.removeEventListener("mute", onMute);
        track.removeEventListener("unmute", onUnmute);
        track.removeEventListener("ended", onEnd);
      };
    };
    read();
    participant.on("localTrackPublished", read);
    participant.on("localTrackUnpublished", read);
    return () => {
      participant.off("localTrackPublished", read);
      participant.off("localTrackUnpublished", read);
      detach?.();
    };
  }, [participant]);

  return state;
}

/** Milliseconds since `startedAt`, ticking once a second. Zero when not started. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

/**
 * One still picture of a capture, taken shortly after it starts.
 *
 * For the entire screen, where a LIVE preview is the one thing we must not show: the
 * screen contains the preview, which contains the screen — an endless mirror that the
 * audience receives too. A single frame has no loop. It answers "which screen is this"
 * without turning into a hall of mirrors.
 */
/** Widest a snapshot is taken at, in pixels. Enough for a retina laptop or 1440p stage. */
const SNAPSHOT_MAX_WIDTH = 2560;

export function useSnapshot(track: MediaStreamTrack | null, enabled: boolean): string | null {
  const [snap, setSnap] = useState<{ track: MediaStreamTrack; url: string } | null>(null);

  useEffect(() => {
    if (!track || !enabled) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    const grab = () => {
      if (cancelled || !video.videoWidth) return;
      /* Sized for the stage it now fills, not a thumbnail: the stage's width in device
       * pixels (a retina laptop stage is ~2200), never above the capture itself, capped so a
       * 5K display does not become a ~10 MB data URL. Taken once per share. */
      const target = Math.min(
        SNAPSHOT_MAX_WIDTH,
        Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
      );
      const scale = Math.min(1, target / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      try {
        /* WebP keeps text edges that JPEG smears at the same size. Browsers without a WebP
         * encoder (older Safari) return PNG instead — larger, still sharp. */
        setSnap({ track, url: canvas.toDataURL("image/webp", 0.92) });
      } catch {
        // A tainted canvas cannot happen with a local capture, but a snapshot is optional.
      }
      video.pause();
      video.srcObject = null;
    };
    // A beat after the first frame: the very first one is often black while capture spins up.
    const timer = window.setTimeout(grab, 700);
    void video.play().catch(() => {});
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      video.pause();
      video.srcObject = null;
    };
  }, [track, enabled]);

  return snap && snap.track === track ? snap.url : null;
}

/* Asking the control bar to do something from elsewhere in the room.
 *
 * The presenter's controls appear in two more places than the bar now — on the stage and
 * in the floating window — and the bar is what owns stopping, re-picking and the floating
 * window. A DOM event rather than a context so the stage does not have to be re-plumbed:
 * dispatchEvent is synchronous, so the click's user activation is still there when the bar
 * handles it, which re-opening the browser's picker and opening a floating window both need. */
export type PresenterAction = "stop" | "switch" | "float";
const EVENT = "webinar:presenter";

export function requestPresenter(action: PresenterAction): void {
  window.dispatchEvent(new CustomEvent<PresenterAction>(EVENT, { detail: action }));
}

export function onPresenterRequest(handler: (action: PresenterAction) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<PresenterAction>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
