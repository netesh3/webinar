"use client";

import { useEffect, useState } from "react";
import { AwayClock, RETURN_QUIET_MS } from "./background-return";

/** True for RETURN_QUIET_MS after the page comes back from being away (lib/background-return.ts).
 *  A "Reconnecting…" badge that reads this stays down while the page catches up by itself, and
 *  shows as before if it has not by then. `onReturn` runs at the moment of return, with how
 *  long the page was away. */
export function useReturnQuiet(onReturn?: (awayMs: number) => void): boolean {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    const clock = new AwayClock(document.visibilityState === "hidden", Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      const away = clock.change(document.visibilityState === "hidden", Date.now());
      if (away === null) return;
      clearTimeout(timer);
      setQuiet(true);
      timer = setTimeout(() => setQuiet(false), RETURN_QUIET_MS);
      onReturn?.(away);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [onReturn]);
  return quiet;
}
