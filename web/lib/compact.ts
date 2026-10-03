"use client";

import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";

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
 *  is the reference floor). The toggles cannot shrink further without
 *  becoming smaller than the icon they hold. The centre buttons scale down
 *  instead (see mobileEngagementFit); whatever still does not fit moves
 *  into More, Reactions included. */
export const MEDIA_TOGGLE_SMALL: { mainPx: number; chevPx: number } = {
  mainPx: 28,
  chevPx: 24,
};

/** Pin-slot budgets for the customisable end of the bar. Unchanged: a phone
 *  below 640px still has none (NARROW_SLOTS), and desktop/tablet keep the
 *  same counts they had. Standing tools (Chat, Q&A, …) are not these slots. */
export const BAR_SLOT_CAPACITY: readonly [query: string, slots: number][] = [
  ["(min-width: 1280px)", 6],
  ["(min-width: 1024px)", 5],
  ["(min-width: 768px)", 4],
  ["(min-width: 640px)", 3],
];

/** Below the last BAR_SLOT_CAPACITY tier. Zero on purpose: a pinned tool
 *  must not open a slot the phone bar does not have room to show. */
export const NARROW_SLOTS = 0;

/** Tailwind `sm`. Labels under bar icons appear at this width and the
 *  buttons go back to min-w-14. The phone scaler stays below it. */
export const PHONE_BAR_BREAK = 640;

/** Today's phone tap target (min-w-10) and glyph (size-5). The scaler never
 *  grows past these, so a wide phone matches the bar it already had. */
export const PHONE_BAR_MAX_PX = 40;
export const PHONE_BAR_ICON_MAX_PX = 20;

/** Narrowest phone tap target. Below this, tools move into More instead of
 *  the buttons getting smaller than the glyph. */
export const PHONE_BAR_MIN_PX = 24;

/** pr-16, which keeps the centre strip clear of the absolute Leave button. */
export const PHONE_BAR_RIGHT_RESERVE = 64;

/** gap-1 on the centre strip, and the empty pin-zone's px-0.5. */
const PHONE_BAR_GAP = 4;
const PHONE_BAR_PIN_PAD = 4;

/** A few pixels of slack so subpixel rounding cannot open a horizontal scroll. */
const PHONE_BAR_SAFETY = 4;

export function mediaToggleSizeForWidth(width: number): { mainPx: number; chevPx: number } {
  for (const [query, mainPx, chevPx] of MEDIA_TOGGLE_TIERS) {
    const min = Number(/\d+/.exec(query)?.[0] ?? "0");
    if (width >= min) return { mainPx, chevPx };
  }
  return MEDIA_TOGGLE_SMALL;
}

/** Pixels the out-of-flow mic/camera cluster occupies, matching
 *  control-bar.tsx: left-2, each toggle's main button + border + chevron,
 *  and gap-1 between them. Zero when neither toggle is showing. */
export function leftClusterReserve(
  toggles: number,
  toggle: { mainPx: number; chevPx: number },
): number {
  if (toggles <= 0) return 0;
  const toggleWidth = toggle.mainPx + 1 + toggle.chevPx;
  return 8 + toggles * toggleWidth + (toggles - 1) * 4;
}

/** Width of the centre strip: engagement buttons, the empty pin-zone, and
 *  More. Leave is reserved separately and is not in this number. */
export function phoneBarRowPx(engagement: number, buttonPx: number): number {
  const buttons = engagement + 1;
  return buttons * buttonPx + PHONE_BAR_PIN_PAD + (engagement + 1) * PHONE_BAR_GAP;
}

export function phoneBarIconPx(buttonPx: number): number {
  if (buttonPx >= 36) return PHONE_BAR_ICON_MAX_PX;
  if (buttonPx >= 30) return 18;
  return 16;
}

export type PhoneBarFit = {
  buttonPx: number;
  iconPx: number;
  /** How many engagement tools (not More, not Leave) fit on this row. */
  slots: number;
  available: number;
};

/** Largest centre-button size that keeps `wanted` engagement tools on one
 *  phone row, shrinking toward PHONE_BAR_MIN_PX and then giving slots back
 *  (caller sheds Q&A / Reactions into More) so the row never scrolls. */
export function mobileEngagementFit(
  width: number,
  toggles: number,
  toggle: { mainPx: number; chevPx: number },
  wanted: number,
): PhoneBarFit {
  const available =
    width -
    leftClusterReserve(toggles, toggle) -
    PHONE_BAR_RIGHT_RESERVE -
    PHONE_BAR_SAFETY;
  const rawButton = (engagement: number) => {
    const n = engagement + 1;
    return Math.floor((available - PHONE_BAR_PIN_PAD) / n) - PHONE_BAR_GAP;
  };
  let slots = Math.max(0, wanted);
  while (slots > 0 && rawButton(slots) < PHONE_BAR_MIN_PX) slots -= 1;
  const raw = rawButton(slots);
  const buttonPx = Math.min(
    PHONE_BAR_MAX_PX,
    Math.max(PHONE_BAR_MIN_PX, raw),
  );
  return {
    buttonPx,
    iconPx: phoneBarIconPx(buttonPx),
    slots,
    available,
  };
}

const PhoneBarMetricsContext = createContext<Pick<PhoneBarFit, "buttonPx" | "iconPx"> | null>(
  null,
);

export function PhoneBarMetricsProvider({
  value,
  children,
}: {
  value: Pick<PhoneBarFit, "buttonPx" | "iconPx"> | null;
  children: ReactNode;
}) {
  return createElement(PhoneBarMetricsContext.Provider, { value }, children);
}

export function usePhoneBarMetrics(): Pick<PhoneBarFit, "buttonPx" | "iconPx"> | null {
  return useContext(PhoneBarMetricsContext);
}

export function useViewportWidth(): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const sync = () => setWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return width;
}

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
