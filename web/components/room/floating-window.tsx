"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { MIN_H, MIN_W, type Rect, type WindowState } from "@/lib/tools";
import { CloseIcon, ExpandIcon, FitIcon, MinusIcon } from "../icons";

/* One floating window.
 *
 * Replaces the docked side panel. The reason is not fashion: a 336px column took
 * a third of the stage away from a 1280px laptop, only one of the four tools
 * could be open at a time, and a host trying to read a question while watching
 * the participant list simply could not. Windows cost the complexity in this file
 * and buy both.
 *
 * What a window has to get right, in the order people notice when it is wrong:
 *
 *   stay reachable   the title bar is the only way to close or move it, so it is
 *                    clamped inside the stage on open, on drag and on every
 *                    viewport change.
 *   raise on touch   any pointer down inside raises it. Two overlapping windows
 *                    where clicking the back one does nothing is the single most
 *                    confusing thing a window manager can do.
 *   keep its place   opening a tool that is already open raises it rather than
 *                    resetting the geometry the user just set.
 *
 * Below `md` it is a bottom sheet instead, and dragging and resizing are gone.
 * A 384px window on a 390px phone is a full-screen dialog with extra steps, and
 * the drag handles would sit under the thumb that is trying to scroll.
 */

/** Which way each handle grows the window. `x`/`y` move the origin, `w`/`h` the
 *  size — so a west edge is `x: 1, w: -1`: the left edge follows the pointer and
 *  the width shrinks by the same amount. */
const EDGES = {
  n: { x: 0, y: 1, w: 0, h: -1, cursor: "ns-resize" },
  s: { x: 0, y: 0, w: 0, h: 1, cursor: "ns-resize" },
  e: { x: 0, y: 0, w: 1, h: 0, cursor: "ew-resize" },
  w: { x: 1, y: 0, w: -1, h: 0, cursor: "ew-resize" },
  ne: { x: 0, y: 1, w: 1, h: -1, cursor: "nesw-resize" },
  nw: { x: 1, y: 1, w: -1, h: -1, cursor: "nwse-resize" },
  se: { x: 0, y: 0, w: 1, h: 1, cursor: "nwse-resize" },
  sw: { x: 1, y: 0, w: -1, h: 1, cursor: "nesw-resize" },
} as const;

type Edge = keyof typeof EDGES;

export type WindowChromeProps = {
  win: WindowState;
  title: string;
  icon: (props: { className?: string }) => ReactNode;
  /** True when this is the top window. Only it takes Escape, or closing one
   *  window would close all of them. */
  focused: boolean;
  compact: boolean;
  /* Collapsed to its title bar.
   *
   * Either the user minimised it, or the screen is too narrow to show more than
   * one window and this is not the one on top. Both are the same shape, and both
   * have to stay in the tree: a window rendered somewhere else in the tree when
   * it collapses is a different React element, so its state — a half-typed
   * message, an hour of scrolled chat — is thrown away. That is the whole reason
   * this is a prop rather than a second component. */
  collapsed: boolean;
  /** Stacking position among the collapsed windows. Only used when compact, where
   *  the rect means nothing and they are stacked from the top instead. */
  collapsedIndex: number;
  /* Stacking rank, 0 for the bottom window.
   *
   * A rank rather than the layout's own z counter, which is monotonic and never
   * reset: after enough focus changes it climbs past the toast stack at 100, and a
   * chat window ends up covering the notification telling somebody they have been
   * muted. There are at most eight tools, so a rank is bounded by construction. */
  level: number;
  badge?: number;
  onFocus: () => void;
  onMove: (rect: Rect) => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  /** Extra controls for the title bar, to the left of minimise. */
  actions?: ReactNode;
  /** Keep the content in the tree while minimised, hidden rather than unmounted.
   *  What it buys is a half-typed message surviving a minimise; what it costs is
   *  whatever the content does while nobody is looking, which is why it is the
   *  tool's decision and not this component's. */
  keepMounted?: boolean;
  children: ReactNode;
};

export function FloatingWindow({
  win,
  title,
  icon: Icon,
  focused,
  compact,
  collapsed,
  collapsedIndex,
  level,
  badge,
  onFocus,
  onMove,
  onMinimize,
  onMaximize,
  onClose,
  actions,
  keepMounted = false,
  children,
}: WindowChromeProps) {
  /* The rect being dragged, held locally and committed on release.
   *
   * Going through the layout on every pointermove would re-render the room's
   * whole context sixty times a second — the window's contents are chat and a
   * participant list, and re-rendering those while a title bar is being dragged
   * is what made the first version stutter. Null means "not dragging, use the
   * committed rect".
   */
  const [live, setLive] = useState<Rect | null>(null);
  const gesture = useRef<{ rect: Rect; x: number; y: number; edge: Edge | null } | null>(null);
  /** The last rect a pointermove produced. The move handler and the release
   *  handler are separate tasks, so the release needs somewhere to read the final
   *  geometry from that is not a closure captured when it subscribed. */
  const latest = useRef<Rect | null>(null);
  const rect = live ?? win.rect;
  const dragging = live !== null;

  const start = useCallback(
    (e: ReactPointerEvent, edge: Edge | null) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      e.stopPropagation();
      onFocus();
      gesture.current = { rect: win.rect, x: e.clientX, y: e.clientY, edge };
      setLive(win.rect);
    },
    [win.rect, onFocus],
  );

  useEffect(() => {
    if (!gesture.current) return;

    const onPointerMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      let dx = e.clientX - g.x;
      let dy = e.clientY - g.y;

      let next: Rect;
      if (!g.edge) {
        next = { ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy };
      } else {
        const edge = EDGES[g.edge];
        // Stop the origin before the size hits its floor. Clamping the size alone
        // would let a west edge keep moving x while w stayed at MIN_W, and the
        // window would slide across the screen instead of refusing to shrink.
        if (edge.w < 0) dx = Math.min(dx, g.rect.w - MIN_W);
        if (edge.w > 0) dx = Math.max(dx, MIN_W - g.rect.w);
        if (edge.h < 0) dy = Math.min(dy, g.rect.h - MIN_H);
        if (edge.h > 0) dy = Math.max(dy, MIN_H - g.rect.h);

        next = {
          x: g.rect.x + dx * edge.x,
          y: g.rect.y + dy * edge.y,
          w: g.rect.w + dx * edge.w,
          h: g.rect.h + dy * edge.h,
        };
      }
      latest.current = next;
      setLive(next);
    };

    const onPointerUp = () => {
      if (!gesture.current) return;
      gesture.current = null;
      const final = latest.current;
      latest.current = null;
      setLive(null);
      // Committed outside the state updater: an updater may run twice in
      // development, and this one would report the drag twice.
      if (final) onMove(final);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    // `dragging` is the subscribe trigger: the listeners exist for exactly as long
    // as a gesture does.
  }, [dragging, onMove]);

  // Escape closes, but only the focused window.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, onClose]);

  const maximized = win.restore !== null;

  // A collapsed window still drags on desktop, so it can be moved out of the way
  // without being expanded first. On a phone it does not: it is a full-width strip
  // with nowhere to go.
  const draggable = !compact;

  const bar = (
    <div
      // The whole title bar is the drag handle, as it is in every OS. The buttons
      // inside it stop propagation so pressing Close does not also start a drag.
      onPointerDown={draggable ? (e) => start(e, null) : undefined}
      onDoubleClick={compact ? undefined : collapsed ? onMinimize : onMaximize}
      className={`flex h-9 shrink-0 items-center gap-2 border-b border-line px-2 select-none ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      } ${focused ? "bg-surface-2" : "bg-surface"}`}
      style={{ touchAction: "none" }}
    >
      <Icon className={`size-4 shrink-0 ${focused ? "text-ink" : "text-ink-3"}`} />
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] font-semibold ${
          focused ? "text-ink" : "text-ink-3"
        }`}
      >
        {title}
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      <div className="flex shrink-0 items-center" onPointerDown={(e) => e.stopPropagation()}>
        {!collapsed && actions}
        <TitleButton
          label={collapsed ? `Show ${title}` : `Minimise ${title}`}
          onClick={onMinimize}
        >
          {collapsed ? <ExpandIcon className="size-3.5" /> : <MinusIcon className="size-3.5" />}
        </TitleButton>
        {/* No maximise on a sheet, which is already the full width of the screen,
            and none on a collapsed bar, where restoring is the only sensible next
            step and is one button to the left. */}
        {!compact && !collapsed && (
          <TitleButton
            label={maximized ? `Restore ${title}` : `Maximise ${title}`}
            onClick={onMaximize}
          >
            {maximized ? <FitIcon className="size-3.5" /> : <ExpandIcon className="size-3.5" />}
          </TitleButton>
        )}
        <TitleButton label={`Close ${title}`} onClick={onClose} danger>
          <CloseIcon className="size-3.5" />
        </TitleButton>
      </div>
    </div>
  );

  /* Where the frame goes, in the four shapes this component has.
   *
   * One `style` computed up front rather than a return per shape, because the
   * children below must be rendered from ONE place — see `collapsed`. Four
   * returns meant four tree positions and a chat that lost its draft. */
  const frame = compact
    ? collapsed
      ? // A full-width strip, stacked from the top of the viewport. The rect is
        // meaningless here: a phone window was never positioned by the user.
        { left: 8, right: 8, top: 8 + collapsedIndex * 42, width: undefined, height: undefined }
      : { left: 0, right: 0, bottom: 0, maxHeight: "72dvh", width: undefined, height: undefined }
    : {
        left: rect.x,
        top: rect.y,
        width: rect.w,
        // A collapsed window is as tall as its title bar, whatever its rect says.
        height: collapsed ? undefined : rect.h,
      };

  const shape = compact
    ? collapsed
      ? "rounded-lg border border-line shadow-xl"
      : "rounded-t-2xl border-t border-line shadow-2xl"
    : collapsed
      ? "rounded-xl border border-line shadow-xl"
      : focused
        ? "rounded-xl border border-line-2 shadow-2xl"
        : "rounded-xl border border-line shadow-lg";

  return (
    <section
      aria-label={collapsed ? `${title} (minimised)` : title}
      // Focus on the way down, so a click that lands on a control inside the
      // window has already raised it by the time the control runs.
      onPointerDown={onFocus}
      className={`room-dark fixed flex flex-col overflow-hidden bg-surface ${shape}`}
      style={{ ...frame, zIndex: 40 + level }}
    >
      {bar}

      {/* min-h-0 so a flex child with its own scroll container actually scrolls
          rather than growing the window past its height.
          `hidden` while collapsed rather than absent: the content stays mounted so
          a draft and a scroll position survive, and `hidden` also takes it out of
          the accessibility tree, which an opacity trick would not. */}
      {(!collapsed || keepMounted) && (
        <div className="flex min-h-0 flex-1 flex-col" hidden={collapsed}>
          {children}
        </div>
      )}

      {/* Resize handles. Eight of them, sized for a pointer rather than for the
          screenshot: 6px edges and 14px corners is roughly what a desktop
          compositor uses, and anything thinner is a hit test people lose. */}
      {!compact && !collapsed && !maximized && (
        <>
          <Handle edge="n" onPointerDown={start} className="top-0 right-3 left-3 h-1.5" />
          <Handle edge="s" onPointerDown={start} className="right-3 bottom-0 left-3 h-1.5" />
          <Handle edge="w" onPointerDown={start} className="top-3 bottom-3 left-0 w-1.5" />
          <Handle edge="e" onPointerDown={start} className="top-3 right-0 bottom-3 w-1.5" />
          <Handle edge="nw" onPointerDown={start} className="top-0 left-0 size-3.5" />
          <Handle edge="ne" onPointerDown={start} className="top-0 right-0 size-3.5" />
          <Handle edge="sw" onPointerDown={start} className="bottom-0 left-0 size-3.5" />
          <Handle edge="se" onPointerDown={start} className="right-0 bottom-0 size-3.5">
            {/* The one visible affordance, because the corner is where people
                look for it. The other seven are invisible, as they are in a
                native window. */}
            <span className="absolute right-1 bottom-1 size-2 rounded-br border-r-2 border-b-2 border-ink-3/60" />
          </Handle>
        </>
      )}
    </section>
  );
}

function Handle({
  edge,
  onPointerDown,
  className,
  children,
}: {
  edge: Edge;
  onPointerDown: (e: ReactPointerEvent, edge: Edge) => void;
  className: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="presentation"
      onPointerDown={(e) => onPointerDown(e, edge)}
      className={`absolute z-10 ${className}`}
      style={{ cursor: EDGES[edge].cursor, touchAction: "none" }}
    >
      {children}
    </div>
  );
}

function TitleButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-7 place-items-center rounded-md text-ink-3 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        danger ? "hover:bg-live/15 hover:text-live" : "hover:bg-surface-3 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

