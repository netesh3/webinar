"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CalendarIcon } from "./icons";
import { Button } from "./ui";
import { instantToZoned, localTimeZone, tzLabel, zonedToInstant } from "@/lib/format";

/* One popover for every absolute date a host picks.
 *
 * Wall-clock values stay YYYY-MM-DD and HH:MM in the zone the caller already
 * stores — the schedule form's fields, a filter's from/to, a broadcast's
 * datetime-local string. Offsets (reminders, "next morning") are not dates
 * and do not come through here.
 */

type YMD = { y: number; m: number; d: number };

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SLOTS: string[] = Array.from({ length: 96 }, (_, i) => {
  const mins = i * 15;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
});

function ymdKey(d: YMD): string {
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

function parseYmd(s: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function weekday(d: YMD): number {
  return new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();
}

function addDays(d: YMD, n: number): YMD {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 };
}

function todayIn(timeZone: string, now = new Date()): YMD {
  const { date } = instantToZoned(now.toISOString(), timeZone);
  return parseYmd(date) ?? { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

function formatIndian(d: YMD, year: boolean): string {
  const head = `${WEEKDAYS[weekday(d)]}, ${d.d} ${MONTHS[d.m - 1]}`;
  return year ? `${head} ${d.y}` : head;
}

function monthTitle(y: number, m: number): string {
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

function formatSlot(hhmm: string): string {
  const [hs, ms] = hhmm.split(":");
  const h = Number(hs);
  if (!Number.isFinite(h) || ms == null) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${ms} ${ampm}`;
}

function zoneAbbrev(timeZone: string, date: string, time: string): string {
  const at = zonedToInstant(date || "2026-06-01", time || "12:00", timeZone);
  return at ? tzLabel(at.toISOString(), timeZone) : timeZone;
}

function slotOk(
  date: string,
  time: string,
  notBeforeMs: number | undefined,
  timeZone: string,
): boolean {
  if (!date || !time) return false;
  if (notBeforeMs == null) return true;
  const at = zonedToInstant(date, time.slice(0, 5), timeZone);
  return at != null && at.getTime() >= notBeforeMs;
}

function dayAllowed(
  day: YMD,
  minDate: string | undefined,
  notBeforeMs: number | undefined,
  timeZone: string,
): boolean {
  const key = ymdKey(day);
  if (minDate && key < minDate) return false;
  return slotOk(key, "23:45", notBeforeMs, timeZone);
}

function firstAllowed(
  date: string,
  prefer: string,
  notBeforeMs: number | undefined,
  timeZone: string,
): string {
  if (prefer && slotOk(date, prefer, notBeforeMs, timeZone)) return prefer;
  return SLOTS.find((s) => slotOk(date, s, notBeforeMs, timeZone)) ?? prefer;
}

function slotsFor(current: string): string[] {
  if (!/^\d{2}:\d{2}$/.test(current) || SLOTS.includes(current)) return SLOTS;
  return [...SLOTS, current].sort();
}

function monthCells(y: number, m: number): YMD[] {
  const first = { y, m, d: 1 };
  const cells: YMD[] = [];
  for (let i = 0; i < weekday(first); i++) cells.push(addDays(first, i - weekday(first)));
  for (let d = 1; d <= daysInMonth(y, m); d++) cells.push({ y, m, d });
  while (cells.length % 7 !== 0) cells.push(addDays(cells[cells.length - 1], 1));
  return cells;
}

function thisWeekend(today: YMD): YMD {
  const wd = weekday(today);
  if (wd === 0 || wd === 6) return today;
  return addDays(today, 6 - wd);
}

function nextMonday(today: YMD): YMD {
  const wd = weekday(today);
  const delta = wd === 0 ? 1 : wd === 1 ? 7 : 8 - wd;
  return addDays(today, delta);
}

const DATE_PRESETS: { id: string; label: string; day: (today: YMD) => YMD }[] = [
  { id: "today", label: "Today", day: (t) => t },
  { id: "tomorrow", label: "Tomorrow", day: (t) => addDays(t, 1) },
  { id: "weekend", label: "This weekend", day: thisWeekend },
  { id: "next", label: "Next week", day: nextMonday },
];

type RangePreset = { id: string; label: string; range: (today: YMD) => { from: YMD; to: YMD } };

const RANGE_PRESETS: RangePreset[] = [
  {
    id: "next7",
    label: "Next 7 days",
    range: (t) => {
      const from = addDays(t, 1);
      return { from, to: addDays(from, 6) };
    },
  },
  {
    id: "month",
    label: "This month",
    range: (t) => ({
      from: { y: t.y, m: t.m, d: 1 },
      to: { y: t.y, m: t.m, d: daysInMonth(t.y, t.m) },
    }),
  },
  {
    id: "last30",
    label: "Last 30 days",
    range: (t) => ({ from: addDays(t, -29), to: t }),
  },
];

function matchingPreset(from: string, to: string, today: YMD): string | null {
  if (!from && !to) return null;
  for (const p of RANGE_PRESETS) {
    const r = p.range(today);
    if (ymdKey(r.from) === from && ymdKey(r.to) === to) return p.id;
  }
  return "custom";
}

function formatRange(from: string, to: string): string {
  const a = parseYmd(from);
  const b = parseYmd(to || from);
  if (!a || !b) return "";
  const [lo, hi] = ymdKey(a) <= ymdKey(b) ? [a, b] : [b, a];
  return `${formatIndian(lo, lo.y !== hi.y)} → ${formatIndian(hi, true)}`;
}

function AnchoredPopover({
  open,
  anchor,
  onClose,
  label,
  watch,
  className = "",
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  watch: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [pos, setPos] = useState({ top: 0, left: 0, ready: false });

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const margin = 8;
      const gap = 6;
      const height = p.offsetHeight;
      const width = p.offsetWidth;
      let top = a.bottom + gap;
      const above = a.top - gap - height;
      if (top + height > window.innerHeight - margin) {
        top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height);
      }
      let left = a.left;
      if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - margin - width);
      }
      setPos({ top, left, ready: true });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, watch]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, anchor]);

  if (!open) return null;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{
        top: pos.top,
        left: pos.left,
        visibility: pos.ready ? "visible" : "hidden",
      }}
      className={`fixed z-[70] max-h-[min(36rem,calc(100dvh-16px))] overflow-auto rounded-xl border border-line bg-surface shadow-[0_12px_32px_-10px_rgba(19,22,25,0.22)] outline-none ${className}`}
    >
      {children}
    </div>
  );
}

function Chip({
  on,
  disabled,
  children,
  onClick,
}: {
  on?: boolean;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[12px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:pointer-events-none disabled:bg-surface-2 disabled:text-ink-3 ${
        on
          ? "border-brand-line bg-brand-soft font-semibold text-brand"
          : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function MonthGrid({
  year,
  month,
  onPrev,
  onNext,
  todayKey,
  selected,
  rangeFrom,
  rangeTo,
  minDate,
  notBeforeMs,
  timeZone,
  onPick,
}: {
  year: number;
  month: number;
  onPrev?: () => void;
  onNext?: () => void;
  todayKey: string;
  selected?: string;
  rangeFrom?: string;
  rangeTo?: string;
  minDate?: string;
  notBeforeMs?: number;
  timeZone: string;
  onPick: (day: YMD) => void;
}) {
  const end = rangeTo || rangeFrom || "";
  const lo = rangeFrom && end && rangeFrom > end ? end : rangeFrom;
  const hi = rangeFrom && end && rangeFrom > end ? rangeFrom : end;

  return (
    <div className="px-2.5 pt-2 pb-1">
      <div className="mb-1 grid grid-cols-[28px_1fr_28px] items-center">
        {onPrev ? (
          <button
            type="button"
            aria-label="Previous month"
            onClick={onPrev}
            className="grid size-7 place-items-center rounded-lg text-[16px] text-ink-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            ‹
          </button>
        ) : (
          <span />
        )}
        <b className="text-center text-[13px] font-semibold">{monthTitle(year, month)}</b>
        {onNext ? (
          <button
            type="button"
            aria-label="Next month"
            onClick={onNext}
            className="grid size-7 place-items-center rounded-lg text-[16px] text-ink-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            ›
          </button>
        ) : (
          <span />
        )}
      </div>
      <div className="grid grid-cols-7">
        {DOW.map((d) => (
          <span
            key={d}
            className="grid h-5 place-items-center text-[10.5px] font-semibold tracking-wide text-ink-3 uppercase"
          >
            {d}
          </span>
        ))}
        {monthCells(year, month).map((day) => {
          const key = ymdKey(day);
          const outside = day.m !== month || day.y !== year;
          const allowed = dayAllowed(day, minDate, notBeforeMs, timeZone);
          const inRange = Boolean(lo && hi && key >= lo && key <= hi);
          const isStart = inRange && key === lo;
          const isEnd = inRange && key === hi;
          const isMid = inRange && !isStart && !isEnd;
          const isOn = selected === key || (isStart && isEnd && !rangeFrom);
          const picked = isOn || (isStart && isEnd);
          return (
            <button
              key={`${year}-${month}-${key}`}
              type="button"
              disabled={!allowed}
              aria-label={formatIndian(day, true)}
              aria-pressed={picked || isStart || isEnd || isMid}
              onClick={() => onPick(day)}
              className={`grid h-8 place-items-center text-[12.5px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:text-[#c5ccd3] ${
                picked
                  ? "rounded-lg bg-brand font-semibold text-white"
                  : isStart
                    ? "rounded-l-lg bg-brand font-semibold text-white"
                    : isEnd
                      ? "rounded-r-lg bg-brand font-semibold text-white"
                      : isMid
                        ? "bg-brand-soft font-semibold text-brand"
                        : `rounded-lg hover:bg-surface-2 ${
                            key === todayKey
                              ? "font-semibold text-brand shadow-[inset_0_0_0_1.5px_var(--color-brand)]"
                              : outside
                                ? "text-ink-3"
                                : "text-ink"
                          }`
              }`}
            >
              {day.d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Footer({
  children,
  actions,
}: {
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-line bg-surface-2 px-2.5 py-2">
      {children}
      <div className="ml-auto flex gap-1.5">{actions}</div>
    </div>
  );
}

/** Date and time together. Presets, a month, and a 15-minute list. */
export function DateTimeField({
  id,
  date,
  time,
  timeZone,
  onChange,
  label,
  ariaLabel = "Date and time",
  minDate,
  notBeforeMs,
  rule,
  invalid,
  className = "",
}: {
  id?: string;
  date: string;
  time: string;
  timeZone: string;
  onChange: (date: string, time: string) => void;
  label?: string;
  ariaLabel?: string;
  /** YYYY-MM-DD. Days before this are disabled. */
  minDate?: string;
  /** Slots earlier than this instant are disabled. */
  notBeforeMs?: number;
  /** Shown in the footer when early slots are blocked, e.g. the one-hour rule. */
  rule?: string;
  invalid?: boolean;
  className?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draftDate, setDraftDate] = useState(date);
  const [draftTime, setDraftTime] = useState(time);
  const [view, setView] = useState<{ y: number; m: number }>({ y: 2026, m: 1 });
  const [today, setToday] = useState<YMD | null>(null);

  function close() {
    setOpen(false);
    anchor.current?.focus();
  }

  function openPanel() {
    const now = todayIn(timeZone);
    setToday(now);
    const parsed = parseYmd(date) ?? now;
    setDraftDate(date);
    setDraftTime(time);
    setView({ y: parsed.y, m: parsed.m });
    setOpen(true);
  }

  function pickDay(day: YMD) {
    if (!dayAllowed(day, minDate, notBeforeMs, timeZone)) return;
    const key = ymdKey(day);
    setDraftDate(key);
    setDraftTime(firstAllowed(key, draftTime || "09:00", notBeforeMs, timeZone));
    setView({ y: day.y, m: day.m });
  }

  function pickPreset(day: YMD) {
    pickDay(day);
  }

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      anchor.current
        ?.ownerDocument.querySelector("[data-time-list] [data-on='true']")
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, draftDate]);

  const canCommit =
    Boolean(parseYmd(draftDate)) &&
    slotOk(draftDate, draftTime, notBeforeMs, timeZone);
  const todayKey = today ? ymdKey(today) : "";
  const abbrev = zoneAbbrev(timeZone, date || draftDate, time || draftTime || "12:00");
  const shown = parseYmd(date);

  return (
    <div className={className}>
      {label && (
        <label className="label" htmlFor={id}>
          {label}
        </label>
      )}
      <button
        ref={anchor}
        id={id}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openPanel())}
        className={`flex h-10 w-full items-center gap-2 rounded-lg border bg-surface px-3 text-left text-[14px] text-ink outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 ${
          invalid
            ? "border-live"
            : open
              ? "border-brand ring-2 ring-brand/20"
              : "border-line"
        }`}
      >
        <CalendarIcon className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate">
          {shown && time ? `${formatIndian(shown, true)} · ${formatSlot(time)}` : "Pick a date and time"}
        </span>
        <span className="shrink-0 rounded-full border border-line-2 bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-ink-2">
          {abbrev}
        </span>
      </button>
      <AnchoredPopover
        open={open}
        anchor={anchor}
        onClose={close}
        label={ariaLabel}
        watch={`${draftDate}-${view.y}-${view.m}`}
        className="w-[min(34rem,calc(100vw-16px))]"
      >
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" role="group" aria-label="Presets">
          {DATE_PRESETS.map((p) => {
            const day = today ? p.day(today) : null;
            const key = day ? ymdKey(day) : "";
            return (
              <Chip
                key={p.id}
                on={key !== "" && key === draftDate}
                disabled={!day || !dayAllowed(day, minDate, notBeforeMs, timeZone)}
                onClick={() => day && pickPreset(day)}
              >
                {p.label}
              </Chip>
            );
          })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_168px]">
          <MonthGrid
            year={view.y}
            month={view.m}
            onPrev={() => setView((v) => shiftMonth(v.y, v.m, -1))}
            onNext={() => setView((v) => shiftMonth(v.y, v.m, 1))}
            todayKey={todayKey}
            selected={draftDate}
            minDate={minDate}
            notBeforeMs={notBeforeMs}
            timeZone={timeZone}
            onPick={pickDay}
          />
          <div
            data-time-list
            className="max-h-64 overflow-y-auto border-t border-line px-2 py-2 sm:border-t-0 sm:border-l"
          >
            <p className="px-2.5 pb-1 text-[11.5px] text-ink-3">15-min steps</p>
            {slotsFor(draftTime).map((slot) => {
              const ok = slotOk(draftDate, slot, notBeforeMs, timeZone);
              const on = slot === draftTime;
              return (
                <button
                  key={slot}
                  type="button"
                  disabled={!ok}
                  data-on={on ? "true" : undefined}
                  aria-pressed={on}
                  onClick={() => setDraftTime(slot)}
                  className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:text-[#c5ccd3] ${
                    on ? "bg-brand-soft font-semibold text-brand" : "hover:bg-surface-2"
                  }`}
                >
                  {formatSlot(slot)}
                  {on && ok ? <span aria-hidden>✓</span> : null}
                </button>
              );
            })}
          </div>
        </div>
        <Footer
          actions={
            <>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canCommit}
                onClick={() => {
                  onChange(draftDate, draftTime.slice(0, 5));
                  close();
                }}
              >
                Done
              </Button>
            </>
          }
        >
          <span className="rounded-full border border-line-2 bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-ink-2">
            {abbrev} · {timeZone}
          </span>
          {rule && notBeforeMs != null && (
            <span className="text-[11.5px] text-ink-3">{rule}</span>
          )}
        </Footer>
      </AnchoredPopover>
    </div>
  );
}

/** A from/to pair. Presets apply immediately; Custom opens two months. */
export function DateRangeField({
  from,
  to,
  onChange,
  timeZone,
  ariaLabel = "Date range",
  emptyLabel = "Any dates",
  size = "md",
  appearance = "field",
  presets = true,
  pressed,
  className = "",
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  /** Zone used for “today” when resolving presets. Defaults to the viewer’s zone. */
  timeZone?: string;
  ariaLabel?: string;
  emptyLabel?: string;
  size?: "sm" | "md";
  appearance?: "field" | "chip";
  /** False skips the chips and opens the two-month calendar (a Custom control). */
  presets?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [showCal, setShowCal] = useState(!presets);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [awaitingEnd, setAwaitingEnd] = useState(false);
  const [view, setView] = useState<{ y: number; m: number }>({ y: 2026, m: 1 });
  const [today, setToday] = useState<YMD | null>(null);
  const zone = timeZone || localTimeZone();

  function close() {
    setOpen(false);
    anchor.current?.focus();
  }

  function openPanel() {
    const now = todayIn(zone);
    setToday(now);
    const start = parseYmd(from) ?? now;
    setDraftFrom(from);
    setDraftTo(to);
    setAwaitingEnd(false);
    setView({ y: start.y, m: start.m });
    const match = matchingPreset(from, to, now);
    setShowCal(!presets || match === "custom");
    setOpen(true);
  }

  function applyPreset(p: RangePreset) {
    if (!today) return;
    const r = p.range(today);
    onChange(ymdKey(r.from), ymdKey(r.to));
    close();
  }

  function pickDay(day: YMD) {
    const key = ymdKey(day);
    if (!draftFrom || !awaitingEnd) {
      setDraftFrom(key);
      setDraftTo(key);
      setAwaitingEnd(true);
      return;
    }
    if (key < draftFrom) {
      setDraftTo(draftFrom);
      setDraftFrom(key);
    } else {
      setDraftTo(key);
    }
    setAwaitingEnd(false);
  }

  function applyCustom() {
    if (!draftFrom) return;
    const end = draftTo || draftFrom;
    const [lo, hi] = draftFrom <= end ? [draftFrom, end] : [end, draftFrom];
    onChange(lo, hi);
    close();
  }

  const labelText =
    from && to
      ? formatRange(from, to)
      : appearance === "chip"
        ? "Custom"
        : emptyLabel;
  const activePreset = today && presets ? matchingPreset(from, to, today) : null;
  const height = size === "sm" ? "h-9 text-[13px]" : "h-10 text-[14px]";
  const right = shiftMonth(view.y, view.m, 1);

  return (
    <div className={className}>
      <button
        ref={anchor}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={appearance === "chip" ? pressed || Boolean(from) : undefined}
        onClick={() => (open ? close() : openPanel())}
        className={
          appearance === "chip"
            ? `inline-flex h-7 items-center rounded-full border px-2.5 text-[12px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                pressed || from
                  ? "border-brand-line bg-brand-soft font-semibold text-brand"
                  : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2"
              }`
            : `flex ${height} w-full items-center gap-2 rounded-lg border bg-surface px-2.5 text-left text-ink outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 sm:w-auto ${
                open ? "border-brand ring-2 ring-brand/20" : "border-line"
              }`
        }
      >
        {appearance === "field" && <CalendarIcon className="size-3.5 shrink-0 text-ink-3" />}
        <span className="truncate">{labelText}</span>
      </button>
      <AnchoredPopover
        open={open}
        anchor={anchor}
        onClose={close}
        label={ariaLabel}
        watch={`${showCal}-${view.y}-${view.m}-${draftFrom}-${draftTo}`}
        className={
          showCal
            ? "w-[min(40rem,calc(100vw-16px))]"
            : "w-[min(22rem,calc(100vw-16px))]"
        }
      >
        {presets && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" role="group" aria-label="Presets">
            {RANGE_PRESETS.map((p) => (
              <Chip key={p.id} on={activePreset === p.id} onClick={() => applyPreset(p)}>
                {p.label}
              </Chip>
            ))}
            <Chip on={showCal} onClick={() => setShowCal(true)}>
              Custom
            </Chip>
          </div>
        )}
        {showCal && today && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2">
              <MonthGrid
                year={view.y}
                month={view.m}
                onPrev={() => setView((v) => shiftMonth(v.y, v.m, -1))}
                todayKey={ymdKey(today)}
                rangeFrom={draftFrom}
                rangeTo={draftTo}
                timeZone={zone}
                onPick={pickDay}
              />
              <MonthGrid
                year={right.y}
                month={right.m}
                onNext={() => setView((v) => shiftMonth(v.y, v.m, 1))}
                todayKey={ymdKey(today)}
                rangeFrom={draftFrom}
                rangeTo={draftTo}
                timeZone={zone}
                onPick={pickDay}
              />
            </div>
            <Footer
              actions={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onChange("", "");
                      close();
                    }}
                  >
                    Clear
                  </Button>
                  <Button type="button" size="sm" disabled={!draftFrom} onClick={applyCustom}>
                    Apply
                  </Button>
                </>
              }
            >
              <span className="text-[11.5px] text-ink-3">
                {draftFrom
                  ? formatRange(draftFrom, draftTo || draftFrom)
                  : "Pick a start and an end"}
              </span>
            </Footer>
          </>
        )}
        {presets && !showCal && <div className="h-2.5" />}
      </AnchoredPopover>
    </div>
  );
}
