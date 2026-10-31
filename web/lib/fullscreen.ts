"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { videoInNativeFullscreen } from "./simulive-clock";
import {
  canElementFullscreen,
  exitElementFullscreen,
  fullscreenElement,
  requestElementFullscreen,
  toggleElementFullscreen,
} from "./fullscreen-api";

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

type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  /** iOS-only, and the only way to observe the native player: no element is
   *  ever `document.fullscreenElement` on an iPhone. */
  webkitDisplayingFullscreen?: boolean;
};

// The element half (standard and webkit-prefixed) is lib/fullscreen-api.ts, which has no
// React in it and so has tests (31 Oct 2026).
export { canElementFullscreen, exitElementFullscreen, requestElementFullscreen };

/** Whether anything is currently fullscreen, including the iOS native player
 *  that no document property reports. */
function readFullscreen(video: HTMLVideoElement | null): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    fullscreenElement() || (video as WebkitVideo | null)?.webkitDisplayingFullscreen,
  );
}

/** Leaves whatever the browser has fullscreen: the document's element or the iOS player. */
async function exitBrowserFullscreen(video: WebkitVideo | null): Promise<void> {
  if (fullscreenElement()) {
    await exitElementFullscreen();
    return;
  }
  try {
    video?.webkitExitFullscreen?.();
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
      const native = () =>
        videoInNativeFullscreen({
          fullscreenElement: fullscreenElement(),
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

    // The container: the standard API, then the webkit-prefixed one. False when neither
    // exists (an iPhone) or both refused (a permissions policy); either way the paths
    // below are sometimes still allowed.
    if (await requestElementFullscreen(container)) return true;

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

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    document.removeEventListener("webkitfullscreenchange", onChange);
  };
}

const noSubscription = () => () => {};

/**
 * Fullscreen for a plain element with no video of its own to fall back on: the room's
 * stage (the Views menu) and a shared screen's tile (31 Oct 2026).
 *
 * `supported` is false on an iPhone, where only a <video> can go fullscreen; the caller
 * hides its button there rather than offer one that does nothing. (The stage was not
 * given pseudo-fullscreen: on a phone it already fills everything between the header and
 * the control bar, and covering those would hide Leave and the sound pill for one strip
 * of extra picture.) False on the server too, so the first render matches the HTML.
 *
 * `active` is read from the document, both APIs, so Escape and the browser's own exit
 * keep the label honest.
 */
export function useElementFullscreen(getElement: () => Element | null): {
  supported: boolean;
  active: boolean;
  toggle: () => Promise<boolean>;
} {
  const supported = useSyncExternalStore(noSubscription, canElementFullscreen, () => false);
  const active = useSyncExternalStore(
    subscribeFullscreen,
    () => {
      const el = getElement();
      return el !== null && fullscreenElement() === el;
    },
    () => false,
  );
  const toggle = useCallback(() => toggleElementFullscreen(getElement()), [getElement]);
  return { supported, active, toggle };
}
