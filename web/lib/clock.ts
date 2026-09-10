"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const subscribeNothing = () => () => {};

/**
 * False during the server render and the first client render, true afterwards.
 *
 * The escape hatch for anything that genuinely cannot match between the two: the
 * viewer's own time zone, their locale's am/pm convention, `window.location`.
 * Rendering nothing until this flips is how those stay out of the hydration
 * comparison — the alternative is a mismatch that React resolves by throwing the
 * whole subtree away and rebuilding it.
 *
 * Not a state-in-effect flag: useSyncExternalStore gives the server a defined
 * snapshot, so there is no extra render pass.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

/**
 * The current time, as a value React is allowed to render.
 *
 * Calling `Date.now()` during render is impure: the server renders one instant
 * and the browser renders another, and React reports a hydration mismatch on a
 * page that looks perfectly fine. This returns null until after hydration, so
 * both passes agree, and then ticks.
 *
 * The first update is scheduled with requestAnimationFrame rather than set
 * directly in the effect body, so nothing renders twice in the same commit.
 */
export function useNow(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const frame = requestAnimationFrame(tick);
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
