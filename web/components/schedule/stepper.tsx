"use client";

import type { ReactNode } from "react";
import { CheckIcon } from "../icons";
import { STEPS, type Step } from "@/lib/schedule-wizard";

export { STEPS, stepFrom, type Step } from "@/lib/schedule-wizard";

export const panelId = (step: Step) => `schedule-panel-${step}`;
const tabId = (step: Step) => `schedule-tab-${step}`;

/* The webinar → Messages & follow-ups, as two cards side by side.
 *
 * Each step is a panel of the same form, and both stay mounted — a card only
 * chooses which one shows. Switching is a state change, never a navigation, so
 * nothing the host typed can be lost to it. The form decides (onStep) whether a
 * step may open; going forward runs the same check as Next. */
export function StepCards({
  step,
  done,
  details,
  onStep,
}: {
  step: Step;
  done: Record<Step, boolean>;
  details: Record<Step, string>;
  onStep: (next: Step) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Schedule steps"
      className="grid gap-2.5 sm:grid-cols-2"
    >
      {STEPS.map((s, i) => {
        const active = s.id === step;
        const complete = !active && done[s.id];
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={tabId(s.id)}
            aria-selected={active}
            aria-current={active ? "step" : undefined}
            aria-controls={panelId(s.id)}
            onClick={() => onStep(s.id)}
            className={`flex min-w-0 items-center gap-3 rounded-xl border bg-surface px-3.5 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              active
                ? "border-brand shadow-[0_0_0_3px_rgba(11,92,255,0.12)]"
                : "border-line hover:border-line-2"
            }`}
          >
            <span
              aria-hidden
              className={`grid size-[26px] shrink-0 place-items-center rounded-full text-[12px] font-semibold ${
                active
                  ? "bg-brand text-white"
                  : complete
                    ? "bg-ok-soft text-ok"
                    : "bg-surface-2 text-ink-2"
              }`}
            >
              {complete ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold text-ink">
                <span className="sr-only">Step {i + 1}: </span>
                {s.title}
                {complete && <span className="sr-only"> (done)</span>}
              </span>
              <span className="mt-px block truncate text-[12px] text-ink-3">
                {details[s.id]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function StepPanel({
  step,
  current,
  children,
}: {
  step: Step;
  current: Step;
  children: ReactNode;
}) {
  return (
    <div
      id={panelId(step)}
      role="tabpanel"
      aria-labelledby={tabId(step)}
      data-schedule-tab={step}
      tabIndex={-1}
      className={`outline-none ${step === current ? "" : "hidden"}`}
    >
      {children}
    </div>
  );
}
