"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ToolId } from "@/lib/tools";
import { tool } from "./tools";

/* Dragging a tool between the bar and the More grid.
 *
 * Pointer events rather than HTML5 drag-and-drop, for three reasons that all
 * showed up in a prototype using the native API: `dragstart` never fires on
 * touch, so the whole feature was desktop-only; the browser's drag image is a
 * washed-out screenshot of the button that cannot be styled; and `dragover`
 * fires on a cadence of its own, which made the drop indicator lag the cursor by
 * an obvious amount.
 *
 * The cost is that everything here — the threshold, the long press, the
 * suppressed click, the ghost — is code the native API would have supplied. That
 * trade is worth making once, in one file, for a gesture the whole UI uses.
 *
 * The gesture, precisely:
 *
 *   mouse   press, move 6px, and you are dragging. Below the threshold it stays
 *           a click, so the bar's buttons still work as buttons.
 *   touch   press and HOLD for 350ms. A threshold alone cannot work here: a
 *           finger moving 6px is how a person taps, so every tap would start a
 *           drag and no tool would ever open.
 *
 * Two drop targets and nothing else: the bar pins, the grid unpins. Releasing
 * anywhere else cancels and puts the tool back where it came from.
 *
 * Release ENDS the drag, unconditionally. Worth stating because the first version
 * did not: it kept the finished gesture around so the click that follows could
 * see that the press had been a drag, and the next mouse movement — button up,
 * six pixels from where the press began — read that leftover gesture and started
 * dragging again. The tool stuck to the cursor and Escape was the only way out.
 * The two concerns are now separate: `gesture` is the live drag and dies on
 * release, `suppress` is a one-shot flag the click handler consumes.
 */

/** Pixels of movement that turn a mouse press into a drag. */
const THRESHOLD = 6;
/** How far a finger may stray before the long press is abandoned as a scroll. */
const TOUCH_SLOP = 12;
/** How long a finger has to stay down before it is a drag rather than a tap. */
const LONG_PRESS_MS = 350;
/** How far above the pointer the ghost floats, so it never covers the drop
 *  indicator it is being aimed at. */
const GHOST_LIFT = 28;

export type DragOrigin = "bar" | "grid";
export type DropTarget = "bar" | "grid" | null;

/* What the rest of the UI needs to know about a drag in progress.
 *
 * Deliberately WITHOUT the pointer position. The ghost follows the cursor by
 * having its style written directly in the move handler, so this object only
 * changes when the drop target changes — a few times per drag instead of sixty
 * times a second. Putting x and y in here re-rendered the control bar, the grid
 * and every slot button on every mouse movement, which is what made the drag feel
 * heavy.
 */
export type Drag = {
  tool: ToolId;
  from: DragOrigin;
  over: DropTarget;
  /** Insertion position within the bar, or null when the bar is not the target. */
  index: number | null;
};

type DragApi = {
  drag: Drag | null;
  /** Everything a draggable tool button needs: the gesture, and a click that is
   *  suppressed when the gesture became a drag. */
  bind: (
    tool: ToolId,
    from: DragOrigin,
    onActivate: () => void,
  ) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    onClick: () => void;
    style: { touchAction: "none" };
  };
  /** The bar registers itself as a drop zone. Its slot elements are found by
   *  `data-tool-slot`, so it does not have to report them separately. */
  setBar: (el: HTMLElement | null) => void;
  setGrid: (el: HTMLElement | null) => void;
};

const DragContext = createContext<DragApi | null>(null);

export function useToolDrag(): DragApi {
  const value = useContext(DragContext);
  if (!value) throw new Error("useToolDrag must be used inside ToolDragProvider");
  return value;
}

/** What the bar's insertion index is under a given x, from the slots on screen. */
function indexAt(bar: HTMLElement, x: number): number {
  const slots = [...bar.querySelectorAll<HTMLElement>("[data-tool-slot]")];
  for (let i = 0; i < slots.length; i++) {
    const r = slots[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return slots.length;
}

function hit(el: HTMLElement | null, x: number, y: number, pad = 0): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

export function ToolDragProvider({
  onPin,
  onUnpin,
  children,
}: {
  onPin: (tool: ToolId, index: number) => void;
  onUnpin: (tool: ToolId) => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const bar = useRef<HTMLElement | null>(null);
  const grid = useRef<HTMLElement | null>(null);
  /** The ghost element, moved by writing its style rather than by rendering. */
  const ghost = useRef<HTMLDivElement | null>(null);
  /** Where the pointer was last seen, so the ghost can be placed the moment it
   *  mounts — a touch drag begins with the finger already still. */
  const point = useRef({ x: 0, y: 0 });

  /* The live gesture. A ref because it changes on every pointermove and is read
   * by handlers that must see the current value, not the one from the render they
   * were created in. Null means no gesture: nothing to promote, nothing to drop. */
  const gesture = useRef<{
    tool: ToolId;
    from: DragOrigin;
    startX: number;
    startY: number;
    active: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  /** Set on release when the press turned out to be a drag; consumed by the click
   *  that follows. Separate from `gesture` so a finished drag cannot be revived. */
  const suppress = useRef(false);

  // Latest callbacks, so the window listeners below never need re-attaching
  // mid-gesture — re-attaching drops the drag.
  const pin = useRef(onPin);
  const unpin = useRef(onUnpin);
  useEffect(() => {
    pin.current = onPin;
    unpin.current = onUnpin;
  }, [onPin, onUnpin]);

  const resolve = useCallback((x: number, y: number): { over: DropTarget; index: number | null } => {
    // The grid is checked first and the bar second, because the More popover sits
    // directly above the bar and their padding overlaps by a few pixels. Grid
    // first means "dropped on the open grid" beats "dropped near the bar", which
    // is what the pointer is visibly over.
    if (hit(grid.current, x, y)) return { over: "grid", index: null };
    // A generous vertical pad: the bar is 56px tall, and asking somebody to land a
    // dragged icon inside it exactly is the difference between a feature that
    // works and one that feels broken.
    if (hit(bar.current, x, y, 24)) {
      return { over: "bar", index: bar.current ? indexAt(bar.current, x) : 0 };
    }
    return { over: null, index: null };
  }, []);

  const moveGhost = useCallback((x: number, y: number) => {
    point.current = { x, y };
    const el = ghost.current;
    if (!el) return;
    // transform, not left/top: it stays on the compositor and does not force a
    // layout pass on every pointer event.
    el.style.transform = `translate3d(${x}px, ${y - GHOST_LIFT}px, 0) translate(-50%, -50%)`;
  }, []);

  const end = useCallback(() => {
    const g = gesture.current;
    if (g?.timer) clearTimeout(g.timer);
    gesture.current = null;
    setDrag(null);
  }, []);

  // One set of window listeners for the whole session. Attached once rather than
  // per-press: setPointerCapture would be neater, but it is released when the
  // captured element unmounts, and dragging a grid item out of a popover that then
  // closes is exactly the case that has to keep working.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;

      if (!g.active) {
        // Only a mouse promotes on distance. A finger waits for the timer, or
        // scrolling and tapping both become drags.
        if (e.pointerType !== "mouse") {
          if (g.timer && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TOUCH_SLOP) {
            // Moved before the long press completed: a scroll or a sloppy tap.
            clearTimeout(g.timer);
            gesture.current = null;
          }
          return;
        }
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < THRESHOLD) return;
        g.active = true;
        moveGhost(e.clientX, e.clientY);
        setDrag({ tool: g.tool, from: g.from, ...resolve(e.clientX, e.clientY) });
        return;
      }

      e.preventDefault();
      moveGhost(e.clientX, e.clientY);

      // React state only when the target actually changes. The ghost has already
      // moved by this point, so a drag across empty space costs nothing.
      const next = resolve(e.clientX, e.clientY);
      setDrag((current) =>
        current && current.over === next.over && current.index === next.index
          ? current
          : { tool: g.tool, from: g.from, ...next },
      );
    };

    const onUp = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;

      if (g.active) {
        const { over, index } = resolve(e.clientX, e.clientY);
        if (over === "bar") {
          pin.current(g.tool, index ?? 0);
        } else if (over === "grid" && g.from === "bar") {
          unpin.current(g.tool);
        }
        // Released on neither: a cancel. Leaving it as an implicit unpin meant a
        // drag abandoned over the video quietly rearranged the bar.
        suppress.current = true;
      }

      // Unconditional. See the note at the top of the file — this is the line
      // whose absence made a finished drag follow the cursor until Escape.
      end();
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", end);
    // A drag that survives the window losing focus — alt-tab mid-drag — never gets
    // its pointerup, so the ghost would be waiting when the user came back.
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [resolve, moveGhost, end]);

  // Escape abandons a drag. Still worth having with release working properly: it
  // is the way out of a touch drag once the finger is already down.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag, end]);

  const bind = useCallback<DragApi["bind"]>(
    (id, from, onActivate) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        // Secondary buttons open context menus; hijacking them for a drag means
        // the user cannot reach their own browser's menu.
        if (e.button !== 0 && e.pointerType === "mouse") return;

        // Any leftover suppression belongs to a previous press whose click never
        // arrived — a drag that ended over a different element. Clearing it here
        // is what keeps that from swallowing this press.
        suppress.current = false;

        const start = {
          tool: id,
          from,
          startX: e.clientX,
          startY: e.clientY,
          active: false,
          timer: null as ReturnType<typeof setTimeout> | null,
        };
        gesture.current = start;
        point.current = { x: e.clientX, y: e.clientY };

        if (e.pointerType !== "mouse") {
          start.timer = setTimeout(() => {
            // Only if this exact press is still the live gesture: a second finger,
            // or a release, replaces or clears it.
            if (gesture.current !== start) return;
            start.active = true;
            start.timer = null;
            // A short buzz where the platform offers one, so a long press that has
            // taken is distinguishable from one that has not.
            navigator.vibrate?.(10);
            setDrag({ tool: id, from, over: null, index: null });
          }, LONG_PRESS_MS);
        }
      },
      onClick: () => {
        if (suppress.current) {
          suppress.current = false;
          return;
        }
        onActivate();
      },
      style: { touchAction: "none" as const },
    }),
    [],
  );

  const api = useMemo<DragApi>(
    () => ({
      drag,
      bind,
      setBar: (el) => {
        bar.current = el;
      },
      setGrid: (el) => {
        grid.current = el;
      },
    }),
    [drag, bind],
  );

  return (
    <DragContext.Provider value={api}>
      {children}
      {drag && (
        <DragGhost
          drag={drag}
          attach={(el) => {
            ghost.current = el;
            if (el) moveGhost(point.current.x, point.current.y);
          }}
        />
      )}
    </DragContext.Provider>
  );
}

/** What follows the pointer.
 *
 *  Fixed and pointer-events-none, so it never becomes its own drop target. Placed
 *  by `moveGhost` writing a transform, not by a style prop — see `Drag`. */
function DragGhost({
  drag,
  attach,
}: {
  drag: Drag;
  attach: (el: HTMLDivElement | null) => void;
}) {
  const t = tool(drag.tool);
  const Icon = t.icon;

  const hint =
    drag.over === "bar"
      ? "Release to pin to the bar"
      : drag.over === "grid"
        ? drag.from === "bar"
          ? "Release to take it off the bar"
          : "Already here"
        : drag.from === "bar"
          ? "Drop on the bar to move it, or on the grid to remove it"
          : "Drop on the bar to pin it";

  return (
    <div
      ref={attach}
      className="pointer-events-none fixed top-0 left-0 z-[110] select-none"
      aria-hidden
    >
      <div className="flex flex-col items-center">
        <div
          className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-2 shadow-2xl transition-colors ${
            drag.over === "bar"
              ? "border-brand bg-brand text-white"
              : drag.over === "grid" && drag.from === "bar"
                ? "border-live bg-live/90 text-white"
                : "border-white/25 bg-ink/90 text-white"
          }`}
        >
          <Icon className="size-5" />
          <span className="text-[10px] leading-none font-semibold">{t.label}</span>
        </div>
        <div className="mt-1.5 rounded-md bg-ink/90 px-2 py-1 text-center text-[10px] font-medium whitespace-nowrap text-white/85">
          {hint}
        </div>
      </div>
    </div>
  );
}
