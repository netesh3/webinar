"use client";

import { useId } from "react";
import { Select } from "../controls";
import {
  MAX_OCCURRENCES,
  planRecurrence,
  weekday,
  withStartWeekday,
  type RecurrenceForm,
} from "@/lib/recurrence";
import type { FormState, SetForm } from "./form-state";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How a recurring series repeats. Shown under When once Type is Recurring series. */
export function RecurrenceFields({
  form,
  set,
  error,
}: {
  form: FormState;
  set: SetForm;
  error?: string;
}) {
  const endName = useId();
  const rule = withStartWeekday(form.recurrence, form.date);
  const plan = planRecurrence(form.date, rule);
  const editingSeries = form.seriesId !== "";
  const thisOnly = editingSeries && form.seriesScope === "this";
  const startWeekday = weekday(form.date);
  const monthlyDay = Number(form.date.slice(8, 10));

  function patch(next: Partial<RecurrenceForm>) {
    set("recurrence", { ...form.recurrence, ...next });
  }

  return (
    <div id="recurrence" className="mt-4 grid gap-3 border-t border-line pt-4">
      {editingSeries && (
        <div>
          <span className="label">Apply this change to</span>
          <div
            role="radiogroup"
            aria-label="Which sessions this edit changes"
            className="flex h-10 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
          >
            {(
              [
                ["this", "This session only"],
                ["following", "This and following"],
              ] as const
            ).map(([scope, label]) => {
              const active = form.seriesScope === scope;
              return (
                <button
                  key={scope}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => set("seriesScope", scope)}
                  className={`flex flex-1 items-center justify-center rounded-md text-[13px] font-medium ${
                    active ? "bg-surface text-ink shadow-sm" : "text-ink-3"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13.5px] font-medium text-ink">
          {thisOnly
            ? form.seriesSummary || plan.summary
            : plan.summary || "Choose how the series repeats."}
        </p>
        <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[12px] font-medium text-warn">
          {MAX_OCCURRENCES} occurrence(s) max
        </span>
      </div>

      {thisOnly ? (
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          Only this session changes. It stays in the series, and a later
          “this and following” edit leaves it alone.
        </p>
      ) : (
        <>
          {editingSeries && (
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              The new time of day applies to this session and later ones that
              were not changed on their own. Sessions that already happened
              stay as they are.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Recurrence"
              value={rule.pattern}
              onChange={(v) =>
                patch({ pattern: v as RecurrenceForm["pattern"] })
              }
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
            <Select
              label="Repeat every"
              value={String(rule.interval)}
              onChange={(v) => patch({ interval: Number(v) })}
            >
              {Array.from({ length: 30 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}{" "}
                  {rule.pattern === "weekly"
                    ? n === 1
                      ? "week"
                      : "weeks"
                    : rule.pattern === "monthly"
                      ? n === 1
                        ? "month"
                        : "months"
                      : n === 1
                        ? "day"
                        : "days"}
                </option>
              ))}
            </Select>
          </div>

          {rule.pattern === "weekly" && (
            <div>
              <span className="label">On</span>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((name, day) => {
                  const on = rule.weekdays.includes(day);
                  const locked = day === startWeekday;
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      disabled={locked}
                      title={locked ? "The first session is on this day" : name}
                      onClick={() => {
                        const weekdays = on
                          ? rule.weekdays.filter((d) => d !== day)
                          : [...rule.weekdays, day].sort((a, b) => a - b);
                        patch({ weekdays });
                      }}
                      className={`h-8 min-w-10 rounded-md border px-2 text-[12.5px] font-medium ${
                        on
                          ? "border-brand bg-brand-soft text-brand"
                          : "border-line bg-surface text-ink-2"
                      } disabled:opacity-100`}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {rule.pattern === "monthly" && Number.isFinite(monthlyDay) && (
            <p className="text-[12.5px] text-ink-3">
              Repeats on the {monthlyDay}
              {ordinalSuffix(monthlyDay)} of each month. A month without that
              day is skipped.
            </p>
          )}

          <fieldset className="grid gap-2">
            <legend className="label">End</legend>
            <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
              <input
                type="radio"
                name={endName}
                checked={rule.end === "by_date"}
                onChange={() => patch({ end: "by_date" })}
              />
              By
              <input
                type="date"
                className="field h-9 w-auto"
                value={rule.endDate}
                disabled={rule.end !== "by_date"}
                onChange={(e) => patch({ end: "by_date", endDate: e.target.value })}
              />
            </label>
            <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
              <input
                type="radio"
                name={endName}
                checked={rule.end === "after_count"}
                onChange={() => patch({ end: "after_count" })}
              />
              After
              <select
                className="field h-9 w-auto"
                value={String(Math.min(Math.max(rule.endCount || 1, 1), MAX_OCCURRENCES))}
                disabled={rule.end !== "after_count"}
                onChange={(e) =>
                  patch({ end: "after_count", endCount: Number(e.target.value) })
                }
              >
                {Array.from({ length: MAX_OCCURRENCES }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              occurrences
            </label>
          </fieldset>
        </>
      )}

      {(error || (!thisOnly && plan.error)) && (
        <p className="text-[12px] font-medium text-live">{error || plan.error}</p>
      )}
    </div>
  );
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
