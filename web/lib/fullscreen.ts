"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

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
 *  3. `video.webkitEnterFullscreen()` — iPhone only, and the reason this file
 *     exists. iOS Safari does not implement the Fullscreen API on elements at
 *     all; a video can only go fullscreen into the native player. Our overlay
 *     is lost there, which is a real downgrade and still better than a button
 *     that does nothing.
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

/**
 * Fullscreen state and a toggle for a player built from a container plus the
 * video inside it.
 *
 * State is read from the browser rather than tracked by us, because Escape,
 * the iOS "Done" button and the browser's own fullscreen affordance all leave
 * fullscreen without going through our button — an assumed boolean is wrong
 * the first time anyone uses one of them, and then the icon lies.
 *
 * Reports whether a request succeeded so a caller can tell the person why
 * nothing happened, rather than leaving them clicking.
 */
export function useFullscreen(
  containerRef: RefObject<HTMLElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
): { isFullscreen: boolean; toggle: () => Promise<boolean> } {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => setIsFullscreen(readFullscreen(videoRef.current));
    sync();

    const video = videoRef.current;
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
  }, [videoRef]);

  const toggle = useCallback(async (): Promise<boolean> => {
    const container = containerRef.current;
    const video = videoRef.current as WebkitVideo | null;
    if (!container) return false;

    if (readFullscreen(video)) {
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

    if (video?.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }, [containerRef, videoRef]);

  return { isFullscreen, toggle };
}
