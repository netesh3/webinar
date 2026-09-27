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
  | "host"
  /** Live captions for everyone — a host-only on/off session control. */
  | "captions"
  /** "Share a video file" — opens the file-share picker. */
  | "sharefile"
  /** Stream to YouTube — a host-only dialog with a live indicator. */
  | "youtube";

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
  "captions",
  "sharefile",
  "youtube",
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

/** On a phone the standing bar (host and panelist — see
 *  CENTER_BAR_COMPACT_ATTENDEE below for attendees) only has room for the two
 *  things that are dead if they arrive a tap late: the two-way conversation
 *  (Chat), and asking to speak (Raise hand) — the one engagement action with
 *  someone on the other end actively waiting on it. Everything else
 *  (Reactions, Polls, Participants, Settings) moves into More, which is
 *  already a bottom sheet on a phone — see more-grid.tsx — so nothing here
 *  becomes harder to reach, it is one tap deeper instead of fighting
 *  mic+camera for the same strip of screen.
 *
 *  Tried keeping five things visible first (this list plus Reactions and
 *  Polls) at MediaToggle's ORIGINAL mobile size (min-w-10 main + w-11
 *  chevron) — the arithmetic didn't work even with correct padding: six
 *  buttons want ~260px and a phone with mic+camera showing left ~119px. Two
 *  fit with room to spare there; five needed the centre strip to scroll.
 *  media-toggle.tsx's mobile sizing has since shrunk (min-w-8 + w-7,
 *  measured) specifically so a FOUR-item attendee bar fits instead — see
 *  CENTER_BAR_COMPACT_ATTENDEE — but this two-item host/panelist bar was
 *  never the one that needed the room, so it stays as-is. */
const CENTER_BAR_COMPACT: readonly ToolId[] = ["chat", "qa", "hand"];

/** Attendee-only (control-bar.tsx passes `attendee` as true only for a
 *  genuine attendee — not host, not a scheduled panelist — via
 *  permissions.promoted, AND only once useMediaToggleSize's tier has room
 *  for it — see attendeeHasRoomForReactions there). Reactions joins Chat +
 *  Raise hand on the bar itself instead of staying in More.
 *
 *  Measured, not guessed, including the case that matters most: a promoted
 *  attendee, with BOTH mic and camera toggles showing on the left, at each
 *  of MediaToggle's three mobile size tiers (lib/compact.ts's
 *  MEDIA_TOGGLE_TIERS). At the middle and large tiers (360px+ phones — most
 *  of them), this four-item bar measures out to fit next to two toggles
 *  with room to spare. Only the narrowest tier (MEDIA_TOGGLE_SMALL, the
 *  smallest phones still sold) still doesn't have room for a promoted
 *  attendee specifically — shrinking the toggles further there would make
 *  them smaller than the icon they hold, so control-bar.tsx falls back to
 *  CENTER_BAR_COMPACT for that one case instead. Every other combination —
 *  including a not-yet-promoted attendee on the smallest phone, where
 *  nothing is claiming the left yet — gets the full four. */
const CENTER_BAR_COMPACT_ATTENDEE: readonly ToolId[] = ["chat", "qa", "hand"];

/** `tucked` is the home tools (HOME_BAR_TOOLS) the person has moved into More
 *  — see tuckedTools. They leave the standing strip rather than showing twice. */
export function centerBarTools(
  available: readonly ToolId[],
  compact: boolean,
  attendee = false,
  tucked: readonly ToolId[] = [],
): ToolId[] {
  const want = compact
    ? attendee
      ? CENTER_BAR_COMPACT_ATTENDEE
      : CENTER_BAR_COMPACT
    : CENTER_BAR_TOOLS;
  return want.filter((id) => available.includes(id) && !tucked.includes(id));
}

/** Engagement tools that did not fit the compact bar, for More's extra row.
 *  A tucked home tool is already in the grid proper, so it is left out here. */
export function morePanelTools(
  available: readonly ToolId[],
  compact: boolean,
  attendee = false,
  tucked: readonly ToolId[] = [],
): ToolId[] | undefined {
  if (!compact) return undefined;
  const onBar = new Set(centerBarTools(available, true, attendee));
  const rest = CENTER_BAR_TOOLS.filter(
    (id) => available.includes(id) && !onBar.has(id) && !tucked.includes(id),
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
  captions: { w: 320, h: 200 },
  sharefile: { w: 320, h: 200 },
  youtube: { w: 320, h: 200 },
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

/* Home tools: on the bar by default, in a standing place of their own, and
 * movable into More like any other tool.
 *
 * YouTube sits beside Record and Settings closes the standing strip — where
 * both always were — rather than in the capacity-limited pin slots. That is
 * what keeps "nothing changes until you move it" true: their positions stay
 * put, and they do not eat into the slots somebody's own pins use.
 *
 * On the bar vs in More is one fact: whether the tool is in `overflow`. Never
 * in `pinned` — its home is its bar position. So a layout saved before these
 * could move (no home tool in `overflow`, because Settings was stripped from
 * it and YouTube was not a tool) loads with both on the bar, exactly as a
 * first-time user gets them, and no storage version bump is needed. */
export const HOME_BAR_TOOLS: readonly ToolId[] = ["youtube", "settings"];

export function isHomeTool(id: ToolId): boolean {
  return HOME_BAR_TOOLS.includes(id);
}

/** Home tools this person has moved into More. */
export function tuckedTools(layout: ToolLayout): ToolId[] {
  return HOME_BAR_TOOLS.filter((id) => layout.overflow.includes(id));
}

/** Tools that must not appear as customisable pins — they already have a
 *  standing place (the strip, or a reserved slot). Home tools are movable, so
 *  they are not excluded here; see isPinSlotTool for the pin slots. */
function isBarExcluded(id: ToolId): boolean {
  return (
    FIXED_BAR_TOOLS.includes(id) ||
    ((CENTER_BAR_TOOLS as readonly string[]).includes(id) && !isHomeTool(id))
  );
}

/** Whether a tool may occupy a pin slot, pinned or surfaced from recent use. */
function isPinSlotTool(id: ToolId): boolean {
  return !isBarExcluded(id) && !isHomeTool(id);
}

export const RECENT_LIMIT = 6;

function emptyLayout(): ToolLayout {
  return {
    pinned: [...DEFAULT_PINNED],
    overflow: TOOL_IDS.filter(isPinSlotTool),
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
 *  tool two slots left inserted a second copy of it.
 *
 *  A home tool goes back to its own place on the bar; the index does not apply. */
export function pinTool(
  layout: ToolLayout,
  tool: ToolId,
  index: number,
): ToolLayout {
  // Centre-cluster tools already have a standing place on the bar.
  if (isBarExcluded(tool)) return layout;
  if (isHomeTool(tool)) {
    if (!layout.overflow.includes(tool)) return layout;
    return { ...layout, overflow: layout.overflow.filter((id) => id !== tool) };
  }
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
 *  Appended to `overflow` rather than restored to its old position — the grid
 *  is displayed in MORE_ORDER regardless (see gridItems), so `overflow` only
 *  records membership.
 *
 *  Also forgets it from `recent`. A tool that surfaced into a vacant slot from
 *  recent use was never pinned, so dragging it back to More used to do nothing
 *  at all — the slot filled itself again from `recent` on the next render. */
export function unpinTool(layout: ToolLayout, tool: ToolId): ToolLayout {
  if (isHomeTool(tool)) {
    if (layout.overflow.includes(tool)) return layout;
    return { ...layout, overflow: [...layout.overflow, tool] };
  }
  if (!layout.pinned.includes(tool) && !layout.recent.includes(tool)) return layout;
  return {
    ...layout,
    pinned: layout.pinned.filter((id) => id !== tool),
    recent: layout.recent.filter((id) => id !== tool),
    overflow:
      layout.overflow.includes(tool) || isBarExcluded(tool)
        ? layout.overflow
        : [...layout.overflow, tool],
  };
}

/** Records a use, most recent first, with no duplicates.
 *
 *  Engagement tools are excluded — they must not surface into vacant bar
 *  slots — and so are home tools, which never go in a pin slot. Settings used
 *  to be recorded here on every open, which alone was enough to make "Reset"
 *  appear on a toolbar nobody had touched. */
export function noteUse(layout: ToolLayout, tool: ToolId): ToolLayout {
  if (isPanelTool(tool) || FIXED_BAR_TOOLS.includes(tool) || isHomeTool(tool)) {
    return layout;
  }
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
  // Home tools never sit in a pin slot either; their home is their slot.
  const pinned = layout.pinned.filter(
    (id) => allowed.has(id) && isPinSlotTool(id),
  );
  // A tucked home tool stays tucked while it is unavailable — that is a
  // preference, not a placement, and dropping it would put YouTube back on
  // the bar the next time this person hosts. Nothing renders it meanwhile:
  // every surface filters by what is available.
  const overflow = layout.overflow.filter(
    (id) => (allowed.has(id) || isHomeTool(id)) && !isBarExcluded(id),
  );
  const placed = new Set([...pinned, ...overflow]);
  // A home tool that is not in More is on the bar — so it is never "added".
  const added = available.filter(
    (id) => !placed.has(id) && isPinSlotTool(id),
  );

  // Windows for a tool that is no longer available have to close, or a demoted
  // panelist keeps a Host tools window whose every button 403s.
  const windows: Record<string, WindowState> = {};
  for (const [key, win] of Object.entries(layout.windows)) {
    if (allowed.has(win.tool)) windows[key] = win;
  }

  const recent = layout.recent.filter(
    (id) => allowed.has(id) && !isPanelTool(id) && !isHomeTool(id),
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
    .filter((id) => allowed.has(id) && isPinSlotTool(id))
    .slice(0, Math.max(0, capacity))
    .map((tool) => ({ tool, pinned: true }));

  if (slots.length >= capacity) return slots;

  const taken = new Set(slots.map((s) => s.tool));
  for (const tool of layout.recent) {
    if (slots.length >= capacity) break;
    if (taken.has(tool) || !allowed.has(tool) || !isPinSlotTool(tool)) continue;
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
 *  phone, in More via morePanelTools). A home tool is here only once it has
 *  been tucked, because only then is it in `overflow`.
 *
 *  In MORE_ORDER, not in the order things happened to be unpinned: a tool
 *  dragged back into More returns to the same spot every time, so a host who
 *  learned where Captions lives finds it there again. */
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
  return moreOrder(out);
}

// ------------------------------------------------------------ customising

/** The one order everything in the More menu is shown in, whichever row it
 *  used to come from: presenting first (share, a video file, captions), then
 *  the conversation tools a phone moves in here, then people, then the
 *  host's own controls and device settings last.
 *
 *  "share" is not a ToolId — it is the screen-share button, which only moves
 *  into More on the narrowest phones — so the list is strings. */
export const MORE_ORDER: readonly string[] = [
  "share",
  "sharefile",
  "captions",
  "youtube",
  "chat",
  "qa",
  "polls",
  "participants",
  "hand",
  "reactions",
  "invite",
  "layout",
  "host",
  "settings",
];

/** Stable sort into MORE_ORDER. Anything unknown keeps its relative order at
 *  the end rather than being dropped. */
export function moreOrder<T extends string>(ids: readonly T[]): T[] {
  const rank = (id: string) => {
    const i = MORE_ORDER.indexOf(id);
    return i === -1 ? MORE_ORDER.length : i;
  };
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map((e) => e.id);
}

/** Whether a tool can be moved between the toolbar and More at all. The
 *  standing strip (Chat, Q&A, …) cannot: it already has a fixed place. Home
 *  tools (YouTube, Settings) can, though they return to their own place. */
export function isPinnable(id: ToolId): boolean {
  return !isBarExcluded(id);
}

/** What a toolbar edit did, so the room can say it in words and offer undo. */
export type ToolbarChange =
  | { kind: "added"; tool: ToolId; bumped: ToolId[] }
  | { kind: "kept"; tool: ToolId }
  | { kind: "moved"; tool: ToolId }
  | { kind: "removed"; tool: ToolId }
  | { kind: "reset" };

/** What undo puts back — exactly the persisted part of the layout. */
export type ToolbarSnapshot = Pick<ToolLayout, "pinned" | "overflow" | "recent">;

export function snapshotToolbar(layout: ToolLayout): ToolbarSnapshot {
  return {
    pinned: [...layout.pinned],
    overflow: [...layout.overflow],
    recent: [...layout.recent],
  };
}

export function restoreToolbar(
  layout: ToolLayout,
  snap: ToolbarSnapshot,
): ToolLayout {
  return {
    ...layout,
    pinned: [...snap.pinned],
    overflow: [...snap.overflow],
    recent: [...snap.recent],
  };
}

/** Which pinned tools the bar can show right now. */
function visiblePins(
  layout: ToolLayout,
  capacity: number,
  available: readonly ToolId[],
): ToolId[] {
  return barSlots(layout, capacity, available)
    .filter((s) => s.pinned)
    .map((s) => s.tool);
}

/** The tool that adding one more would push back into More, or null when there
 *  is room. The last pin goes, because it is the one furthest from the
 *  controls somebody reaches for first. */
export function wouldBump(
  layout: ToolLayout,
  capacity: number,
  available: readonly ToolId[],
  tool?: ToolId,
): ToolId | null {
  // A home tool goes back to its own place, not a pin slot, so it never
  // pushes anything out.
  if (tool && isHomeTool(tool)) return null;
  const pins = visiblePins(layout, capacity, available);
  return capacity > 0 && pins.length >= capacity ? pins[pins.length - 1] : null;
}

/** Converts a position in the pinned list into the index pinTool expects. The
 *  two differ by one when a pinned tool moves to the right of where it
 *  started: pinTool takes it out first, so every later position shifts. */
export function pinIndexForDrop(
  pinned: readonly ToolId[],
  tool: ToolId,
  position: number,
): number {
  const from = pinned.indexOf(tool);
  const at = Math.max(0, position);
  return from !== -1 && from < at ? at - 1 : at;
}

/* Puts a tool on the bar — from a drop, or from an "Add to toolbar" button —
 * without ever breaking the bar's capacity.
 *
 * pinTool alone does not know the capacity, so dropping onto a full bar used
 * to push the last pin past the edge, where it stayed "pinned" but invisible
 * and showed up in More looking unpinned. Here the tool that no longer fits is
 * genuinely moved back to More, and reported, so the room can say so.
 *
 * `slotIndex` is the insertion position among the pinned buttons the bar is
 * showing (what the drag layer measures and the marker is drawn at); omitted
 * means "at the end". Refuses — same layout, no change — when this screen has
 * no customisable slots, or the tool is not one that can move.
 *
 * A home tool (YouTube, Settings) is the exception to both: it goes back to
 * its own place on the bar wherever it was dropped, takes no pin slot, bumps
 * nothing, and so needs no capacity — which also means a phone that tucked
 * one can always put it back.
 */
export function placeOnBar(
  layout: ToolLayout,
  tool: ToolId,
  capacity: number,
  available: readonly ToolId[],
  slotIndex?: number,
): { layout: ToolLayout; change: ToolbarChange | null } {
  if (isHomeTool(tool)) {
    const next = available.includes(tool) ? pinTool(layout, tool, 0) : layout;
    return next === layout
      ? { layout, change: null }
      : { layout: next, change: { kind: "added", tool, bumped: [] } };
  }
  if (capacity <= 0 || !isPinnable(tool) || !available.includes(tool)) {
    return { layout, change: null };
  }
  const pinsBefore = visiblePins(layout, capacity, available);
  const wasPinned = pinsBefore.includes(tool);
  const wasRecent =
    !wasPinned &&
    barSlots(layout, capacity, available).some((s) => s.tool === tool);

  // Slot space -> position in layout.pinned, which may also hold tools this
  // person cannot use right now, or pins a narrower screen has no room for.
  const slot = Math.min(
    Math.max(slotIndex ?? pinsBefore.length, 0),
    pinsBefore.length,
  );
  const position =
    slot < pinsBefore.length
      ? layout.pinned.indexOf(pinsBefore[slot])
      : pinsBefore.length > 0
        ? layout.pinned.indexOf(pinsBefore[pinsBefore.length - 1]) + 1
        : 0;

  let next = pinTool(layout, tool, pinIndexForDrop(layout.pinned, tool, position));
  const bumped: ToolId[] = [];

  if (!wasPinned) {
    // The new tool must be visible — pinning it out of sight is the bug this
    // exists to prevent.
    while (!visiblePins(next, capacity, available).includes(tool)) {
      const shown = visiblePins(next, capacity, available);
      const drop = shown[shown.length - 1];
      if (!drop) break;
      next = unpinTool(next, drop);
      bumped.push(drop);
    }
    // And anything it pushed off the end goes back to More properly, instead
    // of lingering as a pin nobody can see.
    const after = new Set(visiblePins(next, capacity, available));
    for (const id of pinsBefore) {
      if (!after.has(id) && !bumped.includes(id)) {
        next = unpinTool(next, id);
        bumped.push(id);
      }
    }
  }

  if (wasPinned) {
    const same = next.pinned.join() === layout.pinned.join();
    return {
      layout: same ? layout : next,
      change: same ? null : { kind: "moved", tool },
    };
  }
  return {
    layout: next,
    change: wasRecent ? { kind: "kept", tool } : { kind: "added", tool, bumped },
  };
}

/** Moves a tool from the bar back into More — pinned or merely surfaced from
 *  recent use. No change when it was not on the bar to begin with. */
export function removeFromBar(
  layout: ToolLayout,
  tool: ToolId,
): { layout: ToolLayout; change: ToolbarChange | null } {
  const next = unpinTool(layout, tool);
  return next === layout
    ? { layout, change: null }
    : { layout: next, change: { kind: "removed", tool } };
}

/** The default toolbar, keeping whatever windows are open — a reset is about
 *  the buttons, and closing somebody's chat along with it would be a surprise. */
export function resetToolbar(layout: ToolLayout): ToolLayout {
  const fresh = emptyLayout();
  return { ...fresh, windows: layout.windows, nextZ: layout.nextZ };
}

/** Narrows the room-level list to what this browser, right now, can actually
 *  do — for the tools whose availability depends on things the provider does
 *  not know (Share a video file needs the share permission, a browser that can
 *  capture a video element, and a real room rather than the preview). A gate
 *  that is `false` hides the tool; anything unlisted passes through. Kept apart
 *  from `availableTools` so a pin survives a permission flicker instead of
 *  being reconciled away. */
export function usableTools(
  available: readonly ToolId[],
  gates: Partial<Record<ToolId, boolean>>,
): ToolId[] {
  return available.filter((id) => gates[id] !== false);
}

/** Whether the toolbar differs from what a first-time user gets — the only
 *  time "Reset" has anything to do. A tucked home tool counts: Settings in
 *  More is a change somebody may want to undo. */
export function isCustomised(layout: ToolLayout): boolean {
  return (
    layout.pinned.length > 0 ||
    layout.recent.length > 0 ||
    tuckedTools(layout).length > 0
  );
}

/** The sentence the room shows after an edit, in the host's terms rather than
 *  the code's: "toolbar" and "More", never "pin". Null for a plain reorder,
 *  which the landing animation already explains. */
export function describeChange(
  change: ToolbarChange,
  label: (id: ToolId) => string,
): string | null {
  switch (change.kind) {
    case "added":
      return change.bumped.length > 0
        ? `${label(change.tool)} is on your toolbar. ${change.bumped
            .map(label)
            .join(", ")} moved to More to make room.`
        : `${label(change.tool)} is on your toolbar now.`;
    case "kept":
      return `${label(change.tool)} will stay on your toolbar.`;
    case "removed":
      return `${label(change.tool)} moved to More.`;
    case "reset":
      return "Toolbar is back to how it started.";
    case "moved":
      return null;
  }
}

// --------------------------------------------------------------- persistence

/* v6: Layout left its permanent bar slot and became a normal grid tool,
 * starting in More like everything else. Bumped so v5 localStorage — which
 * never had "layout" in its overflow, because it used to be excluded from
 * that set entirely — does not load and permanently lose the tool: `load`
 * below replaces `overflow` wholesale with what it parses from storage, so a
 * stale v5 record would silently drop Layout from every surface rather than
 * placing it in the grid the way a first-time user gets it. See v5's own note
 * just below for the same reasoning applied to Chat / Participants earlier.
 *
 * v7: YouTube and Settings became movable home tools (HOME_BAR_TOOLS), whose
 * place is recorded as "in `overflow` means tucked into More". A v6 record
 * cannot mean that — tucking did not exist — yet some do have "settings" in
 * `overflow`: v6 builds from before Settings joined the standing strip put it
 * there by default. Read as-is, those would open with Settings in More. So v6
 * is read once as a legacy record with every home tool taken out of it (they
 * land on the bar, where they have always been) and everything else — pins,
 * More, recents — kept. No pins are lost to the bump. */
const STORAGE_KEY = "webcast.toolbar.v7";
const LEGACY_STORAGE_KEY = "webcast.toolbar.v6";

/** Only the customisation is persisted, never the windows.
 *
 *  Restoring open windows across a reload would drop somebody back into a
 *  session behind four windows they opened an hour ago, and geometry saved
 *  against a different viewport is wrong more often than it is right. */
type Persisted = { pinned: ToolId[]; overflow: ToolId[]; recent: ToolId[] };

/** A stored record, as a layout. `legacy` is a v6 record, which places every
 *  home tool on the bar. Exported for the migration tests; anything it cannot
 *  read falls back to the default layout. */
export function parseStoredToolbar(
  raw: string | null,
  legacy = false,
): ToolLayout {
  const base = emptyLayout();
  if (!raw) return base;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return base;
    const { pinned, overflow, recent } = parsed as Partial<Persisted>;
    const clean = (value: unknown): ToolId[] =>
      Array.isArray(value) ? [...new Set(value.filter(isToolId))] : [];
    const nextPinned = clean(pinned).filter(isPinSlotTool);
    return {
      ...base,
      pinned: nextPinned,
      overflow: clean(overflow).filter(
        (id) =>
          !nextPinned.includes(id) &&
          !isBarExcluded(id) &&
          !(legacy && isHomeTool(id)),
      ),
      // Opening Settings used to be recorded here, which alone made Reset
      // show on a toolbar nobody had touched.
      recent: clean(recent)
        .filter((id) => !isPanelTool(id) && !isHomeTool(id))
        .slice(0, RECENT_LIMIT),
    };
  } catch {
    // Corrupt or unreadable storage falls back to the default layout rather than
    // taking the room down with it.
    return base;
  }
}

function load(): ToolLayout {
  if (typeof window === "undefined") return emptyLayout();
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    if (current) return parseStoredToolbar(current);
    return parseStoredToolbar(window.localStorage.getItem(LEGACY_STORAGE_KEY), true);
  } catch {
    return emptyLayout();
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
  /** Capacity-aware add or reorder — what both a drop on the bar and an
   *  "Add to toolbar" button use. `slotIndex` is among the pinned buttons on
   *  screen; omitted means at the end. Returns what happened, for the notice. */
  place: (
    tool: ToolId,
    capacity: number,
    slotIndex?: number,
  ) => ToolbarChange | null;
  /** Back to More, pinned or only surfaced from recent use. */
  remove: (tool: ToolId) => ToolbarChange | null;
  /** The persisted part of the layout as it is right now, for undo. */
  snapshot: () => ToolbarSnapshot;
  restore: (snap: ToolbarSnapshot) => void;
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
  // During render, not in an effect: the check is its own guard, so it settles
  // in one extra pass instead of a committed render with a dead tab.
  if (panelTab && !available.includes(panelTab)) setPanelTab(null);

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
      // Computed from the reconciled layout this render saw, not inside a
      // setState updater, so the change can be returned for the notice. Edits
      // are one user gesture apart, so there is no queue of them to race.
      place: (tool, capacity, slotIndex) => {
        const result = placeOnBar(layout, tool, capacity, available, slotIndex);
        if (result.change) setLayout(result.layout);
        return result.change;
      },
      remove: (tool) => {
        const result = removeFromBar(layout, tool);
        if (result.change) setLayout(result.layout);
        return result.change;
      },
      snapshot: () => snapshotToolbar(layout),
      restore: (snap) => setLayout((c) => restoreToolbar(c, snap)),
      used: (tool) => setLayout((c) => noteUse(c, tool)),
      reset: () => setLayout((c) => resetToolbar(c)),
      setStage,
    }),
    [layout, panelTab, bounds, setLayout, available],
  );
}
