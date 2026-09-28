"use client";

import { Fragment, type ReactNode } from "react";
import { CheckIcon } from "../icons";

export type Step = "details" | "survey" | "followups" | "review";

export const STEPS: { id: Step; title: string }[] = [
  { id: "details", title: "Details" },
  { id: "survey", title: "Survey" },
  { id: "followups", title: "Follow-ups" },
  { id: "review", title: "Review" },
];

/** `?step=` to a step. "messages" is what the two-tab form wrote. */
export function stepFrom(value: string | null): Step {
  if (value === "messages") return "followups";
  return STEPS.some((s) => s.id === value) ? (value as Step) : "details";
}

export const panelId = (step: Step) => `schedule-panel-${step}`;
const tabId = (step: Step) => `schedule-tab-${step}`;

/* Details → Survey → Follow-ups → Review.
 *
 * Every step is a panel of the same form, and all four stay mounted — the
 * stepper only chooses which one shows. Switching is a state change, never a
 * navigation, so nothing the host typed can be lost to it. */
export function Stepper({
  step,
  done,
  onStep,
}: {
  step: Step;
  done: Record<Step, boolean>;
  onStep: (next: Step) => void;
}) {
  const current = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-line pb-4">
      <div
        role="tablist"
        aria-label="Schedule steps"
        className="flex min-w-0 items-center gap-2.5 overflow-x-auto"
      >
        {STEPS.map((s, i) => {
          const active = s.id === step;
          const complete = !active && done[s.id];
          return (
            <Fragment key={s.id}>
              {i > 0 && (
                <span
                  aria-hidden
                  className={`h-[1.5px] w-6 shrink-0 sm:w-11 ${
                    i <= current ? "bg-brand" : "bg-line"
                  }`}
                />
              )}
              <button
                type="button"
                role="tab"
                id={tabId(s.id)}
                aria-selected={active}
                aria-controls={panelId(s.id)}
                onClick={() => onStep(s.id)}
                className={`flex shrink-0 items-center gap-2 rounded-full py-0.5 pr-1 text-[12.5px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  active
                    ? "font-semibold text-ink"
                    : complete
                      ? "font-medium text-ink-2 hover:text-ink"
                      : "font-medium text-ink-3 hover:text-ink-2"
                }`}
              >
                <span
                  className={`grid size-[22px] place-items-center rounded-full border-[1.5px] text-[11px] font-bold ${
                    active
                      ? "border-brand bg-brand text-white shadow-[0_0_0_4px_rgba(11,92,255,0.14)]"
                      : complete
                        ? "border-brand bg-brand-soft text-brand"
                        : "border-line-2 bg-surface text-ink-3"
                  }`}
                >
                  {complete ? <CheckIcon className="size-3" /> : i + 1}
                </span>
                {s.title}
              </button>
            </Fragment>
          );
        })}
      </div>
      <p className="ml-auto hidden text-[11.5px] whitespace-nowrap text-ink-3 md:block">
        All steps keep your changes — switch freely
      </p>
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
      className={step === current ? undefined : "hidden"}
    >
      {children}
    </div>
  );
}
