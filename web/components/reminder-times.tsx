"use client";

import { useState } from "react";
import { MaxReminderOffset, MaxReminders, MinReminderOffset } from "@/lib/api-types";
import { PlusIcon, TrashIcon } from "./icons";

/* When the reminders go, for one webinar.
 *
 * Minutes before the start on the wire (options.reminders); an amount and a unit here,
 * because nobody thinks of "a day before" as 1440. The same times drive email and
 * WhatsApp — the toggles beside this decide which channels send them.
 *
 * Up to MaxReminders rows. The server sorts, merges duplicates and bounds each time, so
 * this only keeps the inputs sane and shows what will be sent.
 */

/** A day before and an hour before: what a webinar gets when it never said. Mirrors
 *  types.DefaultReminders on the server, which is a Go var and so not generated. */
export const DEFAULT_REMINDERS: number[] = [24 * 60, 60];

type Unit = "minutes" | "hours" | "days";

const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

// The largest unit a time divides into evenly, so 1440 reads "1 day" and 90 "90 minutes".
function split(total: number): { amount: number; unit: Unit } {
  if (total >= UNIT_MINUTES.days && total % UNIT_MINUTES.days === 0) {
    return { amount: total / UNIT_MINUTES.days, unit: "days" };
  }
  if (total >= UNIT_MINUTES.hours && total % UNIT_MINUTES.hours === 0) {
    return { amount: total / UNIT_MINUTES.hours, unit: "hours" };
  }
  return { amount: total, unit: "minutes" };
}

/** "1 day, 1 hour before" — the times as a host reads them, for summaries. */
export function describeReminders(minutes: number[]): string {
  if (minutes.length === 0) return "None";
  return (
    minutes
      .map((m) => {
        const { amount, unit } = split(m);
        return `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
      })
      .join(", ") + " before"
  );
}

function clamp(minutes: number) {
  return Math.min(MaxReminderOffset, Math.max(MinReminderOffset, Math.round(minutes)));
}

// A sensible next one to add: an hour before, then ten minutes, then a day.
function nextSuggestion(existing: number[]) {
  return [60, 10, 24 * 60, 30, 5].find((m) => !existing.includes(m)) ?? 15;
}

type Row = { id: number; text: string; unit: Unit };

let nextRowId = 1;
function toRow(minutes: number): Row {
  const { amount, unit } = split(minutes);
  return { id: nextRowId++, text: String(amount), unit };
}
function minutesOf(row: Row): number | null {
  const n = Number(row.text);
  return row.text.trim() !== "" && Number.isFinite(n) && n > 0
    ? clamp(n * UNIT_MINUTES[row.unit])
    : null;
}

/* Rows keep what the host typed and the unit they picked, rather than being re-derived
 * from minutes on every keystroke: typing "60" into minutes must not turn into "1 hours"
 * under the cursor, and an emptied box must stay empty until they type again. Only rows
 * with a usable number reach the form. */
export function ReminderTimes({
  value,
  onChange,
  disabled,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  /** Both channels off: the times are kept, and shown as not in use. */
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(() => value.map(toRow));

  const commit = (next: Row[]) => {
    setRows(next);
    onChange(next.map(minutesOf).filter((m): m is number => m !== null));
  };
  const update = (id: number, patch: Partial<Row>) =>
    commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const current = rows.map(minutesOf).filter((m): m is number => m !== null);

  return (
    <div className={disabled ? "opacity-60" : undefined}>
      <span className="label">Reminder times</span>
      {rows.length === 0 ? (
        <p className="mb-2 text-[12.5px] text-ink-2">
          No timed reminders. Registrants still get their confirmation.
        </p>
      ) : (
        <ul className="mb-2 grid gap-2">
          {rows.map((row, i) => (
            <li key={row.id} className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                inputMode="numeric"
                className="field w-24"
                aria-label={`Reminder ${i + 1} amount`}
                aria-invalid={minutesOf(row) === null}
                value={row.text}
                disabled={disabled}
                onChange={(e) => update(row.id, { text: e.target.value })}
              />
              <select
                className="field w-32"
                aria-label={`Reminder ${i + 1} unit`}
                value={row.unit}
                disabled={disabled}
                onChange={(e) => update(row.id, { unit: e.target.value as Unit })}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <span className="text-[13px] text-ink-2">before it starts</span>
              <button
                type="button"
                className="ml-auto rounded p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink"
                aria-label={`Remove reminder ${i + 1}`}
                disabled={disabled}
                onClick={() => commit(rows.filter((r) => r.id !== row.id))}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length < MaxReminders && (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline disabled:opacity-50"
          disabled={disabled}
          onClick={() => commit([...rows, toRow(nextSuggestion(current))])}
        >
          <PlusIcon className="h-3.5 w-3.5" /> Add a reminder
        </button>
      )}
      <p className="mt-1 text-[12px] text-ink-3">
        Up to {MaxReminders}. Used for email and WhatsApp. People who register after a
        reminder&apos;s time don&apos;t get that one.
      </p>
    </div>
  );
}
