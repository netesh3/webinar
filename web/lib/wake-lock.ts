"use client";

import { useEffect } from "react";

/* Keeps the screen on while somebody is in a live room.
 *
 * A phone left on the table to watch a webinar auto-locks after 30 seconds to two
 * minutes. On an iPhone a locked screen suspends the page: the host's audio stops and
 * the WebRTC connection usually drops, so the viewer comes back to "Reconnecting…" or
 * a frozen frame. Android keeps audio longer but still stops the video. Desktop
 * browsers dim the display in a long session too.
 *
 * The Screen Wake Lock API (Chrome/Android 84+, Safari/iOS 16.4+) asks the OS not to.
 * The browser drops the lock whenever the tab is hidden, so it is re-requested each
 * time the page becomes visible again. Where the API is missing, or the request is
 * refused (low battery mode, an iframe without permission), this does nothing: it is
 * a comfort, never a requirement.
 */
type Sentinel = { released: boolean; release(): Promise<void> };
type WakeLockNav = Navigator & {
  wakeLock?: { request(type: "screen"): Promise<Sentinel> };
};

export function useScreenWakeLock(active = true): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return;
    const wl = (navigator as WakeLockNav).wakeLock;
    if (!wl) return;

    let sentinel: Sentinel | null = null;
    let stopped = false;

    const acquire = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return;
      try {
        const next = await wl.request("screen");
        if (stopped) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        // Refused (battery saver, no permission). Nothing to do.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}

/** The hook as a component, for room trees that would rather render it than call it. */
export function KeepScreenOn({ active = true }: { active?: boolean }) {
  useScreenWakeLock(active);
  return null;
}
