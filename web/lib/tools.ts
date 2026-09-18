"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/* The tool layout: what is on the bar, what is in the More grid, and which
 * windows are open where.
 *
 * This file is the state and the geometry, with no JSX and no knowledge of what
 * any tool actually does — the registry that pairs an id with an icon and a
 * component lives in components/room/tools.tsx. Splitting them is what lets the
 * reducer be reasoned about on its own: every function here is a pure transform
 * of one object, which is the only reason a system with dragging, stacking,
 * minimising and persistence stays followable.
 *
 * Four pieces of state, and each exists because something specific goes wrong
 * without it:
 *
 *   pinned     what the user dragged onto the bar. Persisted, or "customise"
 *              means "until you reload".
 *   overflow   the order tools appear in the More grid. Persisted for the same
 *              reason — a grid that reshuffles itself is a grid you have to
 *              re-read every time.
 *   recent     a FIFO of what has actually been used, which fills bar slots the
 *              user has not claimed. Without it an empty bar stays empty.
 *   windows    open windows, with geometry and stacking order. A map rather than
 *              a list because every operation is "the window for this tool".
 */

/** Every tool that can be pinned, put in the grid, or opened as a window. */
export type ToolId =
  | "chat"
  | "qa"
  | "polls"
  | "participants"
  | "invite"
  | "reactions"
  | "hand"
  | "layout"
  | "settings"
  | "host";

export const TOOL_IDS: readonly ToolId[] = [
  "chat",
  "qa",
  "polls",
  "participants",
  "invite",
  "reactions",
  "hand",
  "layout",
  "settings",
  "host",
];

/** Engagement tools that open as an overlay panel (Zoom's Chat / Q&A / Participants).
 *
 *  They live on the bottom bar, not a right-edge icon rail. Opening one overlays
 *  the stage instead of shrinking it — Zoom's video stays full-bleed; ours should
 *  too. Each can still be popped out into a floating window. */
export const PANEL_TOOL_IDS: readonly ToolId[] = [
  "chat",
  "qa",
  "polls",
  "participants",
];

export function isPanelTool(id: ToolId): boolean {
  return (PANEL_TOOL_IDS as readonly string[]).includes(id);
}

/** Always in the centred strip, Zoom-style: mic / camera on the left, these
 *  in the middle, Leave on the right. More is the overflow at the end of this
 *  strip.
 *
 *  Not customisable pins. A host who accidentally unpinned Chat would lose the
 *  one control Zoom never lets you lose. Invite / Layout / Host stay in More
 *  (or as pins) because they are not in Zoom's standing toolbar. */
export const CENTER_BAR_TOOLS: readonly ToolId[] = [
  "chat",
  "qa",
  "polls",
  "participants",
  "hand",
  "reactions",
  "settings",
];

/** On a phone the bar only has room for the two things that are dead if they
 *  arrive a tap late: the two-way conversation (Chat), and asking to speak
 *  (Raise hand) — the one engagement action with someone on the other end
 *  actively waiting on it. Everything else (Reactions, Polls, Participants,
 *  Settings) moves into More, which is already a bottom sheet on a phone —
 *  see more-grid.tsx — so nothing here becomes harder to reach, it is one
 *  tap deeper instead of fighting mic+camera for the same strip of screen.
 *
 *  Tried keeping five things visible first (this list plus Reactions and
 *  Polls) — the arithmetic doesn't work even with correct padding: six
 *  buttons want ~260px and a phone with mic+camera showing leaves ~119px.
 *  Two fits with room to spare; five needed the centre strip to scroll,
 *  which is a worse default than just not asking a 375px screen to hold
 *  that much at once. */
const CENTER_BAR_COMPACT: readonly ToolId[] = ["chat", "hand"];

/** Attendee-only, and only while the full width is actually free — no
 *  mic+camera cluster reserved on the left (control-bar.tsx passes
 *  `attendee` as true only when its own leftClusterCount is 0). The moment
 *  that cluster claims part of a ~375px phone, this drops straight back to
 *  CENTER_BAR_COMPACT: the same measured arithmetic above that ruled out
 *  five things fitting already rules out Chat + Raise hand + Reactions +
 *  More there too — even Share alone doesn't fit that case (see
 *  control-bar.tsx's shareOnBar). Host and panelist never pass `attendee`
 *  at all, so their compact bar is untouched either way. */
const CENTER_BAR_COMPACT_ATTENDEE: readonly ToolId[] = ["chat", "hand", "reactions"];

export function centerBarTools(
  available: readonly ToolId[],
  compact: boolean,
  attendee = false,
): ToolId[] {
  const want = compact
    ? attendee
      ? CENTER_BAR_COMPACT_ATTENDEE
      : CENTER_BAR_COMPACT
    : CENTER_BAR_TOOLS;
  return want.filter((id) => available.includes(id));
}

/** Engagement tools that did not fit the compact bar, for More's extra row. */
export function morePanelTools(
  available: readonly ToolId[],
  compact: boolean,
  attendee = false,
): ToolId[] | undefined {
  if (!compact) return undefined;
  const onBar = new Set(centerBarTools(available, true, attendee));
  const rest = CENTER_BAR_TOOLS.filter(
    (id) => available.includes(id) && !onBar.has(id),
  );
  return rest.length > 0 ? rest : undefined;
}

/** Whether a panel tool is actually in front of the person: its docked tab is open, or it
 *  has been popped out into a window that is not minimised.
 *
 *  One definition, because three surfaces read it — the unread watermark, the badge and
 *  the chat notification card — and a room where the badge and the card disagree about
 *  whether you are looking at chat is a room that notifies you about what is on screen. */
export function isToolVisible(
  layout: ToolLayout,
  panelTab: ToolId | null,
  tool: ToolId,
): boolean {
  const win = layout.windows[tool];
  return panelTab === tool || (!!win && !win.minimized);
}

export function isToolId(value: unknown): value is ToolId {
  return (
    typeof value === "string" && (TOOL_IDS as readonly string[]).includes(value)
  );
}

// ------------------------------------------------------------------- windows

export type Rect = { x: number; y: number; w: number; h: number };

export type WindowState = {
  tool: ToolId;
  rect: Rect;
  /** Stacking and focus order in one number. The highest is on top and focused,
   *  because those are the same thing for a window and keeping two fields in
   *  step is how they end up disagreeing. */
  z: number;
  minimized: boolean;
  /** The geometry to go back to. Set when maximising, cleared on restore —
   *  a maximised window that is dragged should stop being maximised, and
   *  without somewhere to put the old rect it cannot. */
  restore: Rect | null;
};

/** The area windows live in, excluding the header and the control bar. Passed in
 *  rather than read from `window` so the same maths is testable and so a window
 *  is never placed under the bar it was opened from. */
export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Enough of a window to be usable. Below this a chat is a title bar and a
 *  scrollbar, so dragging a resize handle further just wastes the user's time.
 *
 *  Exported because the resize handles need them too: a west or north edge that
 *  clamps the size without also un-moving the origin drags the window sideways
 *  once it hits the floor. */
export const MIN_W = 260;
export const MIN_H = 180;

/** The default size of each window, chosen from what the content actually is: a
 *  conversation wants height, a poll editor wants width for its options. */
const DEFAULT_SIZE: Record<ToolId, { w: number; h: number }> = {
  // Never opens a window — it is a popover anchored to its own bar slot. Present so
  // the record is total and nothing has to handle an undefined.
  layout: { w: 320, h: 240 },
  chat: { w: 384, h: 540 },
  qa: { w: 384, h: 520 },
  polls: { w: 440, h: 560 },
  participants: { w: 372, h: 540 },
  settings: { w: 468, h: 680 },
  host: { w: 468, h: 600 },
  // None of these opens a window — they act immediately, or open their own
  // anchored popover. Sizes exist so the record is total and nothing has to
  // handle an undefined.
  reactions: { w: 320, h: 200 },
  hand: { w: 320, h: 200 },
  invite: { w: 320, h: 200 },
};

/** Keeps a rect inside the usable area, shrinking it if the area is smaller than
 *  the window. Called on open, on drag, on resize and on viewport change: a
 *  window the user cannot reach the title bar of is a window they cannot close. */
export function clampRect(rect: Rect, bounds: Bounds): Rect {
  const areaW = Math.max(MIN_W, bounds.right - bounds.left);
  const areaH = Math.max(MIN_H, bounds.bottom - bounds.top);
  const w = Math.min(Math.max(rect.w, MIN_W), areaW);
  const h = Math.min(Math.max(rect.h, MIN_H), areaH);
  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, bounds.left), bounds.right - w),
    y: Math.min(Math.max(rect.y, bounds.top), bounds.bottom - h),
  };
}

/* Where a newly opened window goes.
 *
 * Cascaded from the top-right, because that is where a sidebar used to be and it
 * keeps the stage clear. Each subsequent window steps down and left so the title
 * bar of the one underneath stays visible and clickable — two windows opened at
 * the same coordinates look like one window and the second cannot be found.
 *
 * The step wraps rather than marching off the bottom of the screen.
 */
const CASCADE = 32;

function placeWindow(tool: ToolId, open: WindowState[], bounds: Bounds): Rect {
  const size = DEFAULT_SIZE[tool];
  const step = open.length % 6;
  const rect = {
    w: size.w,
    h: size.h,
    x: bounds.right - size.w - 16 - step * CASCADE,
    y: bounds.top + 16 + step * CASCADE,
  };
  return clampRect(rect, bounds);
}

// -------------------------------------------------------------------- layout

export type ToolLayout = {
  pinned: ToolId[];
  overflow: ToolId[];
  recent: ToolId[];
  windows: Record<string, WindowState>;
  /** The z to hand the next focused window. Monotonic; never reset, because
   *  re-basing it would need every open window rewritten at once. */
  nextZ: number;
};

/* What a first-time user gets.
 *
 * Chat / Q&A / Polls / Participants / Hand / Reactions / Settings are the
 * standing strip (CENTER_BAR_TOOLS), not pins. Layout, Invite and Host start
 * in More and can be dragged onto the bar the same way they always could.
 */
const DEFAULT_PINNED: ToolId[] = [];

/** Always rendered on the bar outside the capacity-limited pin slots.
 *
 *  Empty, but kept as the one place a future tool would go if something ever
 *  again needs to be guaranteed visible regardless of capacity. The standing
 *  strip is CENTER_BAR_TOOLS, not this list — that strip is not a pin. */
export const FIXED_BAR_TOOLS: readonly ToolId[] = [];

/** Tools that must not appear as customisable pins — they already have a
 *  standing place (the strip, or a reserved slot). */
function isBarExcluded(id: ToolId): boolean {
  return (
    FIXED_BAR_TOOLS.includes(id) ||
    (CENTER_BAR_TOOLS as readonly string[]).includes(id)
  );
}

export const RECENT_LIMIT = 6;

function emptyLayout(): ToolLayout {
  return {
    pinned: [...DEFAULT_PINNED],
    overflow: TOOL_IDS.filter((id) => !isBarExcluded(id)),
    recent: [],
    windows: {},
    nextZ: 1,
  };
}

// ---------------------------------------------------------------- transforms

/** Puts a tool on the bar at an index, taking it out of the grid.
 *
 *  Moving one that is already pinned is a reorder rather than a duplicate — the
 *  same gesture does both, and treating them separately meant dragging a pinned
 *  tool two slots left inserted a second copy of it. */
export function pinTool(
  layout: ToolLayout,
  tool: ToolId,
  index: number,
): ToolLayout {
  // Centre-cluster tools already have a standing place on the bar.
  if (isBarExcluded(tool)) return layout;
  const without = layout.pinned.filter((id) => id !== tool);
  const at = Math.min(Math.max(index, 0), without.length);
  return {
    ...layout,
    pinned: [...without.slice(0, at), tool, ...without.slice(at)],
    overflow: layout.overflow.filter((id) => id !== tool),
  };
}

/** Takes a tool off the bar and returns it to the grid.
 *
 *  Appended rather than restored to its old position: there is no old position
 *  to restore — the grid order is itself user-editable — and putting it at the
 *  end is where the user will look for the thing they just moved. */
export function unpinTool(layout: ToolLayout, tool: ToolId): ToolLayout {
  if (!layout.pinned.includes(tool)) return layout;
  return {
    ...layout,
    pinned: layout.pinned.filter((id) => id !== tool),
    overflow: layout.overflow.includes(tool)
      ? layout.overflow
      : [...layout.overflow, tool],
  };
}

/** Records a use, most recent first, with no duplicates.
 *
 *  Engagement tools are excluded — they must not surface into vacant bar slots. */
export function noteUse(layout: ToolLayout, tool: ToolId): ToolLayout {
  if (isPanelTool(tool) || FIXED_BAR_TOOLS.includes(tool)) return layout;
  return {
    ...layout,
    recent: [tool, ...layout.recent.filter((id) => id !== tool)].slice(
      0,
      RECENT_LIMIT,
    ),
  };
}

export function openWindow(
  layout: ToolLayout,
  tool: ToolId,
  bounds: Bounds,
): ToolLayout {
  const existing = layout.windows[tool];
  const noted = noteUse(layout, tool);

  // Already open: raise and un-minimise it rather than resetting its geometry.
  // Clicking Chat twice must not throw away a window the user just positioned.
  if (existing) {
    return {
      ...noted,
      windows: {
        ...noted.windows,
        [tool]: { ...existing, minimized: false, z: noted.nextZ },
      },
      nextZ: noted.nextZ + 1,
    };
  }

  return {
    ...noted,
    windows: {
      ...noted.windows,
      [tool]: {
        tool,
        rect: placeWindow(tool, Object.values(layout.windows), bounds),
        z: noted.nextZ,
        minimized: false,
        restore: null,
      },
    },
    nextZ: noted.nextZ + 1,
  };
}

export function closeWindow(layout: ToolLayout, tool: ToolId): ToolLayout {
  if (!layout.windows[tool]) return layout;
  const windows = { ...layout.windows };
  delete windows[tool];
  return { ...layout, windows };
}

export function focusWindow(layout: ToolLayout, tool: ToolId): ToolLayout {
  const existing = layout.windows[tool];
  // Already on top: returning the same object keeps a click inside the focused
  // window from re-rendering every other one.
  if (!existing || existing.z === layout.nextZ - 1) return layout;
  return {
    ...layout,
    windows: { ...layout.windows, [tool]: { ...existing, z: layout.nextZ } },
    nextZ: layout.nextZ + 1,
  };
}

export function moveWindow(
  layout: ToolLayout,
  tool: ToolId,
  rect: Rect,
  bounds: Bounds,
): ToolLayout {
  const existing = layout.windows[tool];
  if (!existing) return layout;
  return {
    ...layout,
    windows: {
      ...layout.windows,
      // Dragging or resizing a maximised window makes it a normal window again,
      // so `restore` goes with it. Keeping it would make the next maximise toggle
      // jump back to a rect from minutes ago.
      [tool]: { ...existing, rect: clampRect(rect, bounds), restore: null },
    },
  };
}

export function setMinimized(
  layout: ToolLayout,
  tool: ToolId,
  minimized: boolean,
): ToolLayout {
  const existing = layout.windows[tool];
  if (!existing) return layout;

  if (minimized) {
    return {
      ...layout,
      windows: { ...layout.windows, [tool]: { ...existing, minimized: true } },
    };
  }

  // Restoring raises it. A minimised window is behind everything by the time it
  // is restored, so putting it back without raising it looks like nothing
  // happened at all.
  return {
    ...layout,
    windows: {
      ...layout.windows,
      [tool]: { ...existing, minimized: false, z: layout.nextZ },
    },
    nextZ: layout.nextZ + 1,
  };
}

export function toggleMaximized(
  layout: ToolLayout,
  tool: ToolId,
  bounds: Bounds,
): ToolLayout {
  const existing = layout.windows[tool];
  if (!existing) return layout;

  const next: WindowState = existing.restore
    ? { ...existing, rect: clampRect(existing.restore, bounds), restore: null }
    : {
        ...existing,
        restore: existing.rect,
        rect: {
          x: bounds.left,
          y: bounds.top,
          w: bounds.right - bounds.left,
          h: bounds.bottom - bounds.top,
        },
      };

  return {
    ...layout,
    windows: {
      ...layout.windows,
      [tool]: { ...next, minimized: false, z: layout.nextZ },
    },
    nextZ: layout.nextZ + 1,
  };
}

/** Reflows every open window after the viewport changes. */
export function reflow(layout: ToolLayout, bounds: Bounds): ToolLayout {
  const entries = Object.entries(layout.windows);
  if (entries.length === 0) return layout;

  let changed = false;
  const windows: Record<string, WindowState> = {};
  for (const [key, win] of entries) {
    // A maximised window follows the new bounds instead of being clamped into
    // the old shape, which is the whole point of being maximised.
    const target = win.restore
      ? {
          x: bounds.left,
          y: bounds.top,
          w: bounds.right - bounds.left,
          h: bounds.bottom - bounds.top,
        }
      : clampRect(win.rect, bounds);
    if (
      target.x !== win.rect.x ||
      target.y !== win.rect.y ||
      target.w !== win.rect.w ||
      target.h !== win.rect.h
    ) {
      changed = true;
    }
    windows[key] = { ...win, rect: target };
  }
  return changed ? { ...layout, windows } : layout;
}

/* Reconciles a stored layout against the tools this person can actually use.
 *
 * Both directions matter, and both have bitten:
 *
 *   Unknown ids are dropped. A layout saved by a newer build, or by a session
 *   where this person was the host, otherwise leaves a button that renders
 *   nothing and a grid cell that does nothing.
 *
 *   Newly available tools are added. Permissions change mid-session — the host
 *   turns polls on, or promotes somebody — and a layout computed once at join
 *   would leave the new tool with nowhere to appear. It goes into the grid
 *   rather than onto the bar: appearing in a drawer is discoverable, and a
 *   button materialising under the cursor mid-session is not.
 */
export function reconcile(
  layout: ToolLayout,
  available: readonly ToolId[],
): ToolLayout {
  const allowed = new Set(available);
  // Strip standing-toolbar tools from pins — they already have a centre slot.
  const pinned = layout.pinned.filter(
    (id) => allowed.has(id) && !isBarExcluded(id),
  );
  const overflow = layout.overflow.filter(
    (id) => allowed.has(id) && !isBarExcluded(id),
  );
  const placed = new Set([...pinned, ...overflow]);
  const added = available.filter(
    (id) => !placed.has(id) && !isBarExcluded(id),
  );

  // Windows for a tool that is no longer available have to close, or a demoted
  // panelist keeps a Host tools window whose every button 403s.
  const windows: Record<string, WindowState> = {};
  for (const [key, win] of Object.entries(layout.windows)) {
    if (allowed.has(win.tool)) windows[key] = win;
  }

  const recent = layout.recent.filter(
    (id) => allowed.has(id) && !isPanelTool(id),
  );

  const same =
    pinned.length === layout.pinned.length &&
    overflow.length === layout.overflow.length &&
    added.length === 0 &&
    recent.length === layout.recent.length &&
    Object.keys(windows).length === Object.keys(layout.windows).length;

  return same
    ? layout
    : { ...layout, pinned, overflow: [...overflow, ...added], recent, windows };
}

/* What actually goes on the bar, given the slots available.
 *
 * `pinned` first, then recently used tools to fill what is left. That is the
 * "vacant slots surface recent items" behaviour: a user who has customised
 * nothing still finds the tool they used a minute ago on the bar, and a user who
 * has pinned a full bar never sees it change under them.
 *
 * Recent entries are marked, because a button that appears on its own needs to
 * be explicable — and because dragging one is what turns it into a real pin.
 */
export type BarSlot = { tool: ToolId; pinned: boolean };

export function barSlots(
  layout: ToolLayout,
  capacity: number,
  available: readonly ToolId[],
): BarSlot[] {
  const allowed = new Set(available);
  const slots: BarSlot[] = layout.pinned
    .filter((id) => allowed.has(id) && !isBarExcluded(id))
    .slice(0, Math.max(0, capacity))
    .map((tool) => ({ tool, pinned: true }));

  if (slots.length >= capacity) return slots;

  const taken = new Set(slots.map((s) => s.tool));
  for (const tool of layout.recent) {
    if (slots.length >= capacity) break;
    if (taken.has(tool) || !allowed.has(tool) || isBarExcluded(tool)) continue;
    slots.push({ tool, pinned: false });
    taken.add(tool);
  }
  return slots;
}

/** What the More grid shows: everything not currently on the bar.
 *
 *  Computed from the bar rather than from `overflow` alone, so a tool surfaced
 *  into a vacant slot is not offered in both places at once. Centre-cluster
 *  tools are omitted — they already sit in the middle of the bar (or, on a
 *  phone, in More's extra row via morePanelTools). */
export function gridItems(
  layout: ToolLayout,
  slots: readonly BarSlot[],
  available: readonly ToolId[],
): ToolId[] {
  const onBar = new Set(slots.map((s) => s.tool));
  for (const id of FIXED_BAR_TOOLS) onBar.add(id);
  const allowed = new Set(available);
  const ordered = [...layout.overflow, ...layout.pinned];
  const seen = new Set<ToolId>();
  const out: ToolId[] = [];
  for (const id of ordered) {
    if (
      seen.has(id) ||
      onBar.has(id) ||
      !allowed.has(id) ||
      isBarExcluded(id)
    )
      continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// --------------------------------------------------------------- persistence

/* v6: Layout left its permanent bar slot and became a normal grid tool,
 * starting in More like everything else. Bumped so v5 localStorage — which
 * never had "layout" in its overflow, because it used to be excluded from
 * that set entirely — does not load and permanently lose the tool: `load`
 * below replaces `overflow` wholesale with what it parses from storage, so a
 * stale v5 record would silently drop Layout from every surface rather than
 * placing it in the grid the way a first-time user gets it. See v5's own note
 * just below for the same reasoning applied to Chat / Participants earlier. */
const STORAGE_KEY = "webcast.toolbar.v6";

/** Only the customisation is persisted, never the windows.
 *
 *  Restoring open windows across a reload would drop somebody back into a
 *  session behind four windows they opened an hour ago, and geometry saved
 *  against a different viewport is wrong more often than it is right. */
type Persisted = { pinned: ToolId[]; overflow: ToolId[]; recent: ToolId[] };

function load(): ToolLayout {
  const base = emptyLayout();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return base;
    const { pinned, overflow, recent } = parsed as Partial<Persisted>;
    const clean = (value: unknown): ToolId[] =>
      Array.isArray(value) ? [...new Set(value.filter(isToolId))] : [];
    const nextPinned = clean(pinned).filter((id) => !isBarExcluded(id));
    return {
      ...base,
      pinned: nextPinned,
      overflow: clean(overflow).filter(
        (id) => !nextPinned.includes(id) && !isBarExcluded(id),
      ),
      recent: clean(recent)
        .filter((id) => !isPanelTool(id))
        .slice(0, RECENT_LIMIT),
    };
  } catch {
    // Corrupt or unreadable storage falls back to the default layout rather than
    // taking the room down with it.
    return base;
  }
}

function save(layout: ToolLayout): void {
  if (typeof window === "undefined") return;
  try {
    const persisted: Persisted = {
      pinned: layout.pinned,
      overflow: layout.overflow,
      recent: layout.recent,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Private browsing, or a full quota. Customisation lasts the session.
  }
}

// -------------------------------------------------------------------- bounds

/** How much of the viewport the windows may use.
 *
 *  Measured from the element the room lays the stage out in, so a window cannot
 *  open underneath the header or the control bar — both of which are the things
 *  a user reaches for when they want to get rid of the window. */
export function boundsFrom(el: HTMLElement | null): Bounds {
  if (!el) {
    const w = typeof window === "undefined" ? 1280 : window.innerWidth;
    const h = typeof window === "undefined" ? 720 : window.innerHeight;
    return { left: 8, top: 8, right: w - 8, bottom: h - 8 };
  }
  const r = el.getBoundingClientRect();
  const inset = 8;
  return {
    left: r.left + inset,
    top: r.top + inset,
    right: r.right - inset,
    bottom: r.bottom - inset,
  };
}

// ---------------------------------------------------------------------- hook

export type ToolApi = {
  layout: ToolLayout;
  /** Which engagement tab is open in the docked side panel, or null when closed. */
  panelTab: ToolId | null;
  /** Open (or raise) a tool — panel tools dock unless already undocked. */
  open: (tool: ToolId) => void;
  close: (tool: ToolId) => void;
  /** Close the side panel without touching floating windows. */
  closePanel: () => void;
  /** Open if closed, close if already open and focused — what a toolbar button
   *  does. Anything else makes the button a one-way trip. */
  toggle: (tool: ToolId) => void;
  /** Move a docked engagement tool into a floating window (and drop its panel tab). */
  undock: (tool: ToolId) => void;
  /** Put an undocked engagement tool back into the side panel. */
  dock: (tool: ToolId) => void;
  focus: (tool: ToolId) => void;
  move: (tool: ToolId, rect: Rect) => void;
  minimize: (tool: ToolId, minimized: boolean) => void;
  maximize: (tool: ToolId) => void;
  pin: (tool: ToolId, index: number) => void;
  unpin: (tool: ToolId) => void;
  /** Records a use for a tool that does not open a window, so reactions and
   *  raise-hand can surface in a vacant slot like everything else. */
  used: (tool: ToolId) => void;
  reset: () => void;
  /** The element windows are confined to. */
  setStage: (el: HTMLElement | null) => void;
};

/**
 * Owns the layout: reconciliation, persistence and the viewport.
 *
 * `available` is recomputed by the caller from role and controls, and passed in
 * rather than derived here, because deciding whether somebody may see Host tools
 * is not this file's business.
 */
export function useToolLayout(available: readonly ToolId[]): ToolApi {
  /* Storage is read in the initialiser rather than in an effect.
   *
   * Safe because this never runs on the server: `load` returns the defaults when
   * there is no `window`, and the room itself is only reached after a join
   * response that is fetched in the browser — so the control bar is not in the
   * server-rendered HTML and there is nothing for it to disagree with. Doing it in
   * an effect instead cost a second render of the whole room on every entry, and
   * showed the default bar for a frame before the user's own layout replaced it.
   */
  const [stored, setStored] = useState<ToolLayout>(load);

  /* The engagement tab in the docked side panel.
   *
   * Separate from `windows` on purpose: panel tools are mutually exclusive (one
   * tab at a time), not stacked floating frames. Not persisted — reopening the
   * room with Chat already open would cover the stage before anyone asked.
   */
  const [panelTab, setPanelTab] = useState<ToolId | null>(null);

  /* The element windows are confined to, in state rather than a ref.
   *
   * A ref would be the obvious choice for "the DOM node I was handed", and it is
   * wrong here for two reasons. `bounds` has to change when the element does, so
   * that a window opened before the stage was measured is still placed inside it;
   * and a ref reachable through the returned object makes every read of
   * `tools.layout` in a component body a ref access during render, which is both
   * a lint error and a real staleness bug waiting to happen.
   */
  const [stage, setStage] = useState<HTMLElement | null>(null);

  /* Reconciled on read, not in an effect.
   *
   * It is a pure function of the stored layout and what is available, so deriving
   * it is both simpler and correct-by-construction. As an effect it was a second
   * render pass every time a control changed, and it had to be written carefully
   * enough to return the identical object when nothing had changed or it looped.
   */
  const availableKey = available.join(",");
  const layout = useMemo(
    () =>
      reconcile(
        stored,
        availableKey ? (availableKey.split(",") as ToolId[]) : [],
      ),
    [stored, availableKey],
  );

  // Drop a panel tab that is no longer available (host turned polls off, etc.).
  useEffect(() => {
    if (panelTab && !available.includes(panelTab)) setPanelTab(null);
  }, [available, panelTab]);

  // The derived layout is what gets saved, so a tool that appeared mid-session
  // keeps the position it was given.
  useEffect(() => {
    save(layout);
  }, [layout]);

  // The viewport changing has to move the windows, or rotating a tablet leaves
  // them off screen with no way back.
  useEffect(() => {
    const onResize = () =>
      setStored((current) => reflow(current, boundsFrom(stage)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [stage]);

  const bounds = useCallback(() => boundsFrom(stage), [stage]);
  const setLayout = setStored;

  return useMemo<ToolApi>(
    () => ({
      layout,
      panelTab,
      open: (tool) => {
        // Undocked engagement tools stay windows — opening Chat must not yank
        // a floating frame the host just positioned back into the rail.
        if (isPanelTool(tool) && !layout.windows[tool]) {
          setPanelTab(tool);
          return;
        }
        setLayout((c) => openWindow(c, tool, bounds()));
      },
      close: (tool) => {
        if (isPanelTool(tool)) {
          setPanelTab((current) => (current === tool ? null : current));
          setLayout((c) => closeWindow(c, tool));
          return;
        }
        setLayout((c) => closeWindow(c, tool));
      },
      closePanel: () => setPanelTab(null),
      toggle: (tool) => {
        if (isPanelTool(tool) && !layout.windows[tool]) {
          setPanelTab((current) => (current === tool ? null : tool));
          return;
        }
        setLayout((c) => {
          const win = c.windows[tool];
          // Open, on top and visible means the button that opened it now closes
          // it. Open but buried or minimised means bring it forward — the user
          // pressed the button because they could not see it.
          if (win && !win.minimized && win.z === c.nextZ - 1)
            return closeWindow(c, tool);
          return openWindow(c, tool, bounds());
        });
      },
      undock: (tool) => {
        if (!isPanelTool(tool)) return;
        setPanelTab((current) => {
          if (current !== tool) return current;
          // Keep the rail useful: jump to another docked tab if one remains.
          const next = PANEL_TOOL_IDS.find(
            (id) =>
              id !== tool &&
              available.includes(id) &&
              !layout.windows[id],
          );
          return next ?? null;
        });
        setLayout((c) => openWindow(c, tool, bounds()));
      },
      dock: (tool) => {
        if (!isPanelTool(tool)) return;
        setLayout((c) => closeWindow(c, tool));
        setPanelTab(tool);
      },
      focus: (tool) => {
        if (isPanelTool(tool) && !layout.windows[tool]) {
          setPanelTab(tool);
          return;
        }
        setLayout((c) => focusWindow(c, tool));
      },
      move: (tool, rect) =>
        setLayout((c) => moveWindow(c, tool, rect, bounds())),
      minimize: (tool, minimized) =>
        setLayout((c) => setMinimized(c, tool, minimized)),
      maximize: (tool) => setLayout((c) => toggleMaximized(c, tool, bounds())),
      pin: (tool, index) => setLayout((c) => pinTool(c, tool, index)),
      unpin: (tool) => setLayout((c) => unpinTool(c, tool)),
      used: (tool) => setLayout((c) => noteUse(c, tool)),
      reset: () =>
        setLayout((c) => {
          const fresh = emptyLayout();
          return { ...fresh, windows: c.windows, nextZ: c.nextZ };
        }),
      setStage,
    }),
    [layout, panelTab, bounds, setLayout, available],
  );
}
