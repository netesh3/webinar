"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/* Width of the inbox list column. The reading pane keeps the rest.
 *
 * Saved under wl-email-inbox-list. Below 900px the panes stack and the
 * separator is not shown, so this width is only applied at that breakpoint. */

export const INBOX_LIST_MIN = 280;
export const INBOX_READING_MIN = 360;
const SEPARATOR = 8;
const DEFAULT_WIDTH = 380;
const STORAGE_KEY = "wl-email-inbox-list";

/* Conversations per page. The list card stays full height; this is how many
 * rows fit above the pager. Clamped so a short pane still shows a page and a
 * large monitor does not request the whole mailbox. */

export const INBOX_PAGE_MIN = 3;
export const INBOX_PAGE_MAX = 15;
export const INBOX_PAGE_DEFAULT = 5;
/** Three-line row (13/13/12, py-3, border) until a real row is measured. */
export const INBOX_ROW_FALLBACK = 86;
/** Pager footer before it mounts: border, py-2.5, and the h-8 button. */
export const INBOX_PAGER_FALLBACK = 53;
export const INBOX_MEASURE_DEBOUNCE_MS = 200;

/** Rows that fit in `availablePx`, or null when the pane has not been measured. */
export function inboxRowsThatFit(availablePx: number, rowPx: number): number | null {
  if (!(availablePx > 0) || !(rowPx > 0)) return null;
  const fit = Math.floor(availablePx / rowPx);
  if (!Number.isFinite(fit)) return null;
  return Math.min(INBOX_PAGE_MAX, Math.max(INBOX_PAGE_MIN, fit));
}

const listeners = new Set<() => void>();
let cached: number | null = null;

function readWidth(): number {
  if (cached != null) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    cached = Number.isFinite(n) && n >= INBOX_LIST_MIN ? n : DEFAULT_WIDTH;
  } catch {
    cached = DEFAULT_WIDTH;
  }
  return cached;
}

function writeWidth(next: number) {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(next)));
  } catch {
    // Private mode can refuse storage. The width still applies for this view.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      cached = null;
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function clampWidth(n: number, max: number) {
  return Math.min(Math.max(Math.round(n), INBOX_LIST_MIN), Math.max(INBOX_LIST_MIN, max));
}

export function useInboxListWidth(sectionRef: RefObject<HTMLElement | null>) {
  const preferred = useSyncExternalStore(subscribe, readWidth, () => DEFAULT_WIDTH);
  const [max, setMax] = useState(720);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const measure = () => {
      const room = el.clientWidth - INBOX_READING_MIN - SEPARATOR;
      setMax(Math.max(INBOX_LIST_MIN, room));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sectionRef]);

  const width = clampWidth(dragWidth ?? preferred, max);

  useEffect(() => {
    if (!dragging) return;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!window.matchMedia("(min-width: 900px)").matches) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.focus();
      const section = sectionRef.current;
      if (!section) return;
      handle.setPointerCapture(event.pointerId);
      const originX = event.clientX;
      const origin = width;
      let latest = origin;
      setDragging(true);

      const roomFor = () => {
        const room = section.clientWidth - INBOX_READING_MIN - SEPARATOR;
        return clampWidth(room, room);
      };
      const move = (ev: PointerEvent) => {
        latest = clampWidth(origin + (ev.clientX - originX), roomFor());
        setDragWidth(latest);
      };
      const end = (ev: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        const next =
          ev.type === "pointercancel"
            ? latest
            : clampWidth(origin + (ev.clientX - originX), roomFor());
        writeWidth(next);
        setDragWidth(null);
        setDragging(false);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [sectionRef, width],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!window.matchMedia("(min-width: 900px)").matches) return;
      const step = event.shiftKey ? 48 : 16;
      let next = width;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = width - step;
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = width + step;
      else if (event.key === "Home") next = INBOX_LIST_MIN;
      else if (event.key === "End") next = max;
      else return;
      event.preventDefault();
      writeWidth(clampWidth(next, max));
    },
    [width, max],
  );

  return {
    width,
    min: INBOX_LIST_MIN,
    max,
    dragging,
    onPointerDown,
    onKeyDown,
  };
}
