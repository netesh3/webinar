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
/** How tall the video/stage area stays at the top of the screen when a panel
 *  (Chat, Participants, …) is open on a phone-shaped viewport — the panel
 *  itself starts exactly here (see side-panel.tsx), via this same constant,
 *  so the two can never drift out of sync with each other. Clamped rather
 *  than a flat vh: a flat percentage left the video uncomfortably short on a
 *  small phone and needlessly tall on a big one — this keeps a real video at
 *  the top and real room for the panel below it across phone sizes. */
export const COMPACT_STAGE_HEIGHT = "clamp(180px, 38vh, 320px)";

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

/**
 * Mic/camera's own three width tiers on a phone-shaped screen — a phone's
 * own width varies far more than "phone vs not" (a 2016 SE and a current Pro
 * Max differ by over 100px), and a size picked for one end either overflows
 * the other or wastes the room it has to spare.
 *
 * Each tuple is [media query, main-button px, device-picker-chevron px].
 * Checked widest-first so the first match wins. Below the narrowest of
 * these, MEDIA_TOGGLE_SMALL applies.
 *
 * Every number here was measured, not guessed, against media-toggle.tsx's
 * and control-bar.tsx's actual markup (a static harness driving real
 * getBoundingClientRect() calls, not CSS estimated by eye) — this is the
 * exact pixel width Chat + Raise hand + Reactions + More need clear of two
 * of these side by side, on top of whatever the real phone's width is. See
 * media-toggle.tsx for how these are applied, and control-bar.tsx's
 * leftReservePx, which has to reserve exactly this many pixels by hand —
 * there is no single source of truth between an out-of-flow absolute
 * cluster and the padding that reserves room for it, so a change here has to
 * be reflected there too. */
export const MEDIA_TOGGLE_TIERS: readonly [
  query: string,
  mainPx: number,
  chevPx: number,
][] = [
  // 410px+: iPhone Pro Max / most large Android phones. Verified with 16px
  // to spare before Leave.
  ["(min-width: 410px)", 36, 32],
  // 360-409px: the common middle — most current iPhones and Android phones.
  // Verified with 8px to spare at the narrow (360px) end of this tier.
  ["(min-width: 360px)", 32, 28],
];

/** Below 360px — the smallest phones still sold (the 2016 iPhone SE's 320px
 *  is the reference floor). At this size even Chat + Raise hand + Reactions
 *  + More next to two full-size toggles does not fit however far the
 *  toggles themselves shrink without becoming smaller than the icon they
 *  hold — see control-bar.tsx for the one place that still falls back to
 *  hiding Reactions, and only at this narrowest tier. */
export const MEDIA_TOGGLE_SMALL: { mainPx: number; chevPx: number } = {
  mainPx: 28,
  chevPx: 24,
};

export function useMediaToggleSize(): { mainPx: number; chevPx: number } {
  const [size, setSize] = useState(MEDIA_TOGGLE_SMALL);
  useEffect(() => {
    const queries = MEDIA_TOGGLE_TIERS.map(
      ([q, mainPx, chevPx]) => [window.matchMedia(q), mainPx, chevPx] as const,
    );
    const sync = () => {
      const hit = queries.find(([mq]) => mq.matches);
      setSize(hit ? { mainPx: hit[1], chevPx: hit[2] } : MEDIA_TOGGLE_SMALL);
    };
    sync();
    for (const [mq] of queries) mq.addEventListener("change", sync);
    return () => {
      for (const [mq] of queries) mq.removeEventListener("change", sync);
    };
  }, []);
  return size;
}
