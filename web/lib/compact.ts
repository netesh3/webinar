"use client";

import { useEffect, useState } from "react";

/** `md`, matching the Tailwind class the room's own layout switches at, so a
 *  sheet appears exactly when the stage stops having room beside it. Shared
 *  by every room surface that has a compact/full-size distinction — the
 *  floating tool windows, the "More" overflow grid — so they all become
 *  mobile-shaped at the same width rather than each carrying its own
 *  slightly-different breakpoint. */
export const COMPACT_QUERY = "(max-width: 767px)";

/**
 * Whether the room is narrow enough to be phone-shaped right now.
 *
 * False for the server render and the first client render, then the truth.
 * Sniffing a user agent would be wrong on a narrow desktop window, which is
 * the case this actually has to get right — a resized browser window is as
 * "compact" as a phone, and a phone in landscape is not.
 */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return compact;
}
