"use client";

import { useEffect, useState } from "react";
import { MaterialIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import {
  TimingAfterEnd,
  TimingBefore,
  TimingNextMorning,
  TimingOnPublish,
  type MessageTiming,
} from "@/lib/api-types";
import { durationLabel, hourLabel, minutesOf } from "./message-timing";

const MAX_REMINDERS = 3;
const MAX_MINUTES = 30 * 24 * 60;

type Unit = "minutes" | "hours" | "days";

function toMinutes(n: number, unit: Unit): number {
  if (unit === "hours") return n * 60;
  if (unit === "days") return n * 1440;
  return n;
}

/* The chip's popover. Reminder times are the default for new webinars.
 * Replay is "when I publish" or a wait after the end. A follow-up is one
 * of the four usual waits, or a custom one. */
export function TimingPicker({
  mode,
  title,
  timing,
  busy,
  onClose,
  onSave,
}: {
  mode: "reminder" | "replay" | "followup";
  title: string;
  timing: MessageTiming;
  busy?: boolean;
  onClose: () => void;
  onSave: (timing: MessageTiming) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute top-[calc(100%+8px)] left-0 z-30 w-[21.5rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface text-left shadow-lg"
      role="dialog"
      aria-label={title}
    >
      <div className="flex items-center justify-between px-3.5 pt-3">
        <b className="text-[13.5px] font-semibold text-ink">{title}</b>
        <button type="button" aria-label="Close" onClick={onClose} className="text-ink-3">
          <MaterialIcon name="close" className="!text-[18px]" />
        </button>
      </div>
      <div className="px-3.5 pt-2.5 pb-3">
        {mode === "reminder" && (
          <ReminderBody timing={timing} busy={busy} onClose={onClose} onSave={onSave} />
        )}
        {mode === "replay" && (
          <ReplayBody timing={timing} busy={busy} onClose={onClose} onSave={onSave} />
        )}
        {mode === "followup" && (
          <FollowupBody timing={timing} busy={busy} onClose={onClose} onSave={onSave} />
        )}
      </div>
    </div>
  );
}

function Footer({
  onClose,
  onSave,
  disabled,
  busy,
}: {
  onClose: () => void;
  onSave: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="-mx-3.5 mt-3 flex justify-end gap-2 rounded-b-xl border-t border-line bg-surface-2 px-3.5 py-2.5">
      <Button size="sm" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button size="sm" onClick={onSave} disabled={disabled || busy}>
        Save
      </Button>
    </div>
  );
}

function ReminderBody({
  timing,
  busy,
  onClose,
  onSave,
}: {
  timing: MessageTiming;
  busy?: boolean;
  onClose: () => void;
  onSave: (timing: MessageTiming) => void;
}) {
  const [mins, setMins] = useState<number[]>(() => minutesOf(timing));
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<Unit>("minutes");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const n = Math.round(Number(amount));
    const next = toMinutes(n, unit);
    if (!Number.isFinite(n) || n < 1 || next < 1 || next > MAX_MINUTES) {
      setError("Use a time between 1 minute and 30 days.");
      return;
    }
    if (mins.includes(next)) {
      setError("That time is already there.");
      return;
    }
    if (mins.length >= MAX_REMINDERS) {
      setError(`At most ${MAX_REMINDERS} reminders.`);
      return;
    }
    setError(null);
    setMins((prev) => [...prev, next].sort((a, b) => b - a));
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {mins.map((m) => (
          <span
            key={m}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-line-2 bg-surface pr-1.5 pl-2.5 text-[12.5px]"
          >
            {durationLabel(m)} before
            <button
              type="button"
              aria-label={`Remove ${durationLabel(m)} before`}
              className="text-ink-3"
              onClick={() => setMins((prev) => prev.filter((x) => x !== m))}
            >
              <MaterialIcon name="close" className="!text-[15px]" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-surface-2 p-2 text-[12.5px] text-ink-2">
        <input
          className="field h-7 w-14 text-center text-[12.5px]"
          inputMode="numeric"
          aria-label="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <select
          className="field h-7 text-[12.5px]"
          aria-label="Unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value as Unit)}
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        <span className="flex-1">before</span>
        <button type="button" className="font-semibold text-brand" onClick={add}>
          Add
        </button>
      </div>
      {error && <p className="mt-2 text-[11.5px] text-live">{error}</p>}
      <p className="mt-2.5 text-[11.5px] leading-snug text-ink-3">
        Every new webinar starts with these. You can still change them on any webinar
        while scheduling.
      </p>
      <Footer
        onClose={onClose}
        busy={busy}
        disabled={mins.length === 0}
        onSave={() => onSave({ type: TimingBefore, minutes: mins })}
      />
    </>
  );
}

function ReplayBody({
  timing,
  busy,
  onClose,
  onSave,
}: {
  timing: MessageTiming;
  busy?: boolean;
  onClose: () => void;
  onSave: (timing: MessageTiming) => void;
}) {
  const initialAfter = timing.type === TimingAfterEnd;
  const [mode, setMode] = useState<"publish" | "after">(initialAfter ? "after" : "publish");
  const [hours, setHours] = useState(() => {
    const m = minutesOf(timing)[0];
    return m && m % 60 === 0 ? String(m / 60) : "2";
  });

  return (
    <>
      <label
        className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[13px] ${
          mode === "publish" ? "border-brand bg-brand-soft" : "border-line"
        }`}
      >
        <input
          type="radio"
          name="replay-when"
          checked={mode === "publish"}
          onChange={() => setMode("publish")}
        />
        When I publish the recording
      </label>
      <label
        className={`mt-1.5 flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[13px] ${
          mode === "after" ? "border-brand bg-brand-soft" : "border-line"
        }`}
      >
        <input
          type="radio"
          name="replay-when"
          checked={mode === "after"}
          onChange={() => setMode("after")}
        />
        Automatically,
        <select
          className="field h-6 text-[12.5px]"
          aria-label="Hours after it ends"
          value={hours}
          onChange={(e) => {
            setHours(e.target.value);
            setMode("after");
          }}
        >
          {[1, 2, 4, 6, 12, 24].map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        hours after it ends
      </label>
      <p className="mt-2.5 text-[11.5px] leading-snug text-ink-3">
        Automatic needs the recording to be ready.
      </p>
      <Footer
        onClose={onClose}
        busy={busy}
        onSave={() =>
          onSave(
            mode === "publish"
              ? { type: TimingOnPublish }
              : { type: TimingAfterEnd, minutes: [Number(hours) * 60] },
          )
        }
      />
    </>
  );
}

const FOLLOWUPS: { id: string; label: string; timing: MessageTiming }[] = [
  { id: "60", label: "1 hour after", timing: { type: TimingAfterEnd, minutes: [60] } },
  { id: "120", label: "2 hours after", timing: { type: TimingAfterEnd, minutes: [120] } },
  {
    id: "morning",
    label: "Next morning (9 AM)",
    timing: { type: TimingNextMorning, hour: 9 },
  },
  { id: "1440", label: "1 day after", timing: { type: TimingAfterEnd, minutes: [1440] } },
];

function followupId(timing: MessageTiming): string {
  if (timing.type === TimingNextMorning && (timing.hour ?? 9) === 9) return "morning";
  if (timing.type === TimingAfterEnd) {
    const m = minutesOf(timing)[0];
    if (m === 60 || m === 120 || m === 1440) return String(m);
  }
  return "custom";
}

function FollowupBody({
  timing,
  busy,
  onClose,
  onSave,
}: {
  timing: MessageTiming;
  busy?: boolean;
  onClose: () => void;
  onSave: (timing: MessageTiming) => void;
}) {
  const [picked, setPicked] = useState(() => followupId(timing));
  const [amount, setAmount] = useState(() => {
    const m = minutesOf(timing)[0] ?? 180;
    if (m % 1440 === 0) return String(m / 1440);
    if (m % 60 === 0) return String(m / 60);
    return String(m);
  });
  const [unit, setUnit] = useState<Unit>(() => {
    const m = minutesOf(timing)[0] ?? 180;
    if (m % 1440 === 0) return "days";
    if (m % 60 === 0) return "hours";
    return "minutes";
  });
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (picked !== "custom") {
      const choice = FOLLOWUPS.find((c) => c.id === picked);
      if (choice) onSave(choice.timing);
      return;
    }
    const n = Math.round(Number(amount));
    const mins = toMinutes(n, unit);
    if (!Number.isFinite(n) || n < 0 || mins > 90 * 1440) {
      setError("Use a wait up to 90 days.");
      return;
    }
    onSave({ type: TimingAfterEnd, minutes: [mins] });
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {FOLLOWUPS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setPicked(c.id)}
            className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12.5px] ${
              picked === c.id
                ? "border-brand bg-brand-soft font-semibold text-brand"
                : "border-line-2 text-ink"
            }`}
          >
            {picked === c.id && <MaterialIcon name="check" className="!text-[15px]" />}
            {c.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPicked("custom")}
          className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[12.5px] ${
            picked === "custom"
              ? "border-brand bg-brand-soft font-semibold text-brand"
              : "border-line-2 text-ink"
          }`}
        >
          Custom…
        </button>
      </div>
      {picked === "custom" && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <input
            className="field h-7 w-16 text-center text-[12.5px]"
            inputMode="numeric"
            aria-label="Custom wait"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <select
            className="field h-7 text-[12.5px]"
            aria-label="Custom unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as Unit)}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
          <span>after it ends</span>
        </div>
      )}
      {error && <p className="mt-2 text-[11.5px] text-live">{error}</p>}
      <p className="mt-2.5 text-[11.5px] leading-snug text-ink-3">
        Counted from when the webinar ends.
        {timing.type === TimingNextMorning && timing.hour != null && timing.hour !== 9
          ? ` Currently ${hourLabel(timing.hour)}.`
          : ""}
      </p>
      <Footer onClose={onClose} busy={busy} onSave={save} />
    </>
  );
}
