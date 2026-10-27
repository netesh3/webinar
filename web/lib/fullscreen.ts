"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { videoInNativeFullscreen } from "./simulive-clock";

/* Fullscreen for a video surface, across the three APIs browsers actually ship.
 *
 * `Element.requestFullscreen` alone is not enough, and the way it fails is the
 * worst kind: on an iPhone it is simply absent, so `el.requestFullscreen?.()`
 * is a button that does nothing at all — no error, no console, nothing to
 * report. Attendees are the most mobile audience we have, which is where that
 * gap gets found.
 *
 * Three paths, in descending order of how much control we keep:
 *
 *  1. The standard API on the container, so our own overlay (the Live pill, the
 *     mute button) comes along into fullscreen with the video.
 *  2. The webkit-prefixed container call, for Safari versions that predate the
 *     unprefixed one.
 *  3. iPhone, where iOS Safari does not implement the Fullscreen API on elements
 *     at all:
 *     - `nativeVideo: true`: `video.webkitEnterFullscreen()`, the native player.
 *       Our overlay is lost there.
 *     - `nativeVideo: false` (the stage players, StagePlayerChrome): never the
 *       native player — its scrubber takes a simulive off the shared clock, and it
 *       drops our overlays, the phone speaker split among them. The container goes
 *       pseudo-fullscreen instead (`pseudo`: the caller fixes it over the whole
 *       viewport with CSS), our chrome and all.
 *
 * `nativeVideo: false` also guards against the native player opening without our button:
 * a pinch out on an iOS video, or Android Chrome's rotate-to-fullscreen making the
 * <video> itself the fullscreen element. Either is left at once for pseudo-fullscreen
 * (lib/simulive-clock.ts videoInNativeFullscreen).
 */

type WebkitElement = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  /** iOS-only, and the only way to observe the native player: no element is
   *  ever `document.fullscreenElement` on an iPhone. */
  webkitDisplayingFullscreen?: boolean;
};

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** Whether this browser can make an element (our container, with our chrome) fullscreen.
 *  False on an iPhone, whose only fullscreen is the native video player. Client only. */
export function canElementFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as Document & { webkitFullscreenEnabled?: boolean };
  const el = document.documentElement as WebkitElement;
  const api =
    typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function";
  return api && Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

/** Whether anything is currently fullscreen, including the iOS native player
 *  that no document property reports. */
function readFullscreen(video: HTMLVideoElement | null): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as WebkitDocument;
  return Boolean(
    doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      (video as WebkitVideo | null)?.webkitDisplayingFullscreen,
  );
}

/** Leaves whatever the browser has fullscreen: the document's element or the iOS player. */
async function exitBrowserFullscreen(video: WebkitVideo | null): Promise<void> {
  const doc = document as WebkitDocument;
  try {
    if (doc.fullscreenElement && doc.exitFullscreen) await doc.exitFullscreen();
    else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen)
      await doc.webkitExitFullscreen();
    else video?.webkitExitFullscreen?.();
  } catch {
    // Leaving fullscreen is not something to report; the browser will have
    // its own reason and the person can press Escape.
  }
}

/**
 * Fullscreen state and a toggle for a player built from a container plus the
 * video inside it.
 *
 * State is read from the browser rather than tracked by us, because Escape,
 * the iOS "Done" button and the browser's own fullscreen affordance all leave
 * fullscreen without going through our button — an assumed boolean is wrong
 * the first time anyone uses one of them, and then the icon lies. The one
 * exception is pseudo-fullscreen, which is ours: `pseudo` says the caller should
 * fix the container over the viewport.
 *
 * Reports whether a request succeeded so a caller can tell the person why
 * nothing happened, rather than leaving them clicking.
 */
export function useFullscreen(
  containerRef: RefObject<HTMLElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
  /** Whether the iPhone fallback, the native video player, is allowed. A simulive says no:
   *  that player brings its own play button and scrubber (lib/simulive-clock.ts), so it
   *  gets pseudo-fullscreen instead, and the native player is left if it opens anyway. */
  { nativeVideo = true }: { nativeVideo?: boolean } = {},
): { isFullscreen: boolean; pseudo: boolean; toggle: () => Promise<boolean> } {
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [pseudo, setPseudo] = useState(false);

  useEffect(() => {
    const video = videoRef.current as WebkitVideo | null;
    const sync = () => {
      setBrowserFullscreen(readFullscreen(video));
      if (nativeVideo || !video) return;
      const doc = document as WebkitDocument;
      const native = () =>
        videoInNativeFullscreen({
          fullscreenElement: doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null,
          video,
          webkitDisplayingFullscreen: video.webkitDisplayingFullscreen,
        });
      if (!native()) return;
      // The native player, with its scrubber: out of it, and into ours.
      setPseudo(true);
      void exitBrowserFullscreen(video);
      // iOS can ignore an exit inside webkitbeginfullscreen, before the animation settles.
      setTimeout(() => {
        if (native()) void exitBrowserFullscreen(video);
      }, 300);
    };
    sync();

    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    // iOS fires these on the video, not the document.
    video?.addEventListener("webkitbeginfullscreen", sync);
    video?.addEventListener("webkitendfullscreen", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      video?.removeEventListener("webkitbeginfullscreen", sync);
      video?.removeEventListener("webkitendfullscreen", sync);
    };
  }, [videoRef, nativeVideo]);

  // Pseudo-fullscreen: Escape leaves it, as it would the real thing, and the page behind
  // it does not scroll.
  useEffect(() => {
    if (!pseudo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPseudo(false);
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [pseudo]);

  const toggle = useCallback(async (): Promise<boolean> => {
    const container = containerRef.current;
    const video = videoRef.current as WebkitVideo | null;
    if (!container) return false;

    if (pseudo) {
      setPseudo(false);
      return true;
    }

    if (readFullscreen(video)) {
      await exitBrowserFullscreen(video);
      return true;
    }

    if (container.requestFullscreen) {
      try {
        await container.requestFullscreen();
        return true;
      } catch {
        // Falls through: a rejection here is usually a permissions policy, and
        // the video-element path below is sometimes still allowed.
      }
    }

    const webkitContainer = container as WebkitElement;
    if (webkitContainer.webkitRequestFullscreen) {
      try {
        await webkitContainer.webkitRequestFullscreen();
        return true;
      } catch {
        // Falls through to the iOS video path.
      }
    }

    // A simulive: our own fullscreen, never the native player.
    if (!nativeVideo) {
      setPseudo(true);
      return true;
    }

    if (video?.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }, [containerRef, videoRef, nativeVideo, pseudo]);

  return { isFullscreen: browserFullscreen || pseudo, pseudo, toggle };
}
