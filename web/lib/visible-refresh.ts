"use client";

import { useEffect } from "react";

/**
 * Re-run `refresh` when this tab is looked at, and on an interval while it stays
 * visible. A background tab does not poll — same choice as the host alerts bell.
 *
 * `window` focus covers the extra room window (Electron, window.open): that
 * dashboard often stays `visibilityState === "visible"` the whole time, so
 * visibilitychange never fires when the host comes back.
 */
export function useVisibleRefresh(refresh: () => void, intervalMs = 30_000): void {
  useEffect(() => {
    const onLook = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onLook);
    window.addEventListener("focus", onLook);
    const timer = setInterval(onLook, intervalMs);
    return () => {
      document.removeEventListener("visibilitychange", onLook);
      window.removeEventListener("focus", onLook);
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);
}
