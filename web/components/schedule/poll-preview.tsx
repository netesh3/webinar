"use client";

import { useState } from "react";
import {
  buildPollInput,
  letterFor,
  type ComposerDraft,
} from "@/lib/poll-view";
import { CheckIcon } from "../icons";

/** Compact attendee-style card for the schedule Feedback preview column. */
export function SchedulePollPreview({
  draft,
  label,
  hint,
}: {
  draft: ComposerDraft;
  label: string;
  hint?: string;
}) {
  const built = buildPollInput(draft);
  const options = built.ok
    ? built.input.options
    : draft.options.map((o) => o.trim()).filter(Boolean);
  const question = draft.question.trim() || "Your question";
  const [choice, setChoice] = useState(0);
  const quiz = draft.quiz;
  const correctIdx =
    quiz && built.ok ? (built.input.correctOption ?? -1) : -1;

  return (
    <div>
      <p className="label mb-1.5 flex h-4 items-center justify-between gap-2">
        <span>{label}</span>
        {hint && (
          <span className="truncate text-[10.5px] font-medium normal-case tracking-normal text-ink-3">
            {hint}
          </span>
        )}
      </p>
      <div
        className="room-dark rounded-xl border border-line-2 bg-surface p-3 shadow-[0_8px_24px_-16px_rgba(0,0,0,0.45)]"
        style={{ zoom: 0.86 }}
      >
        <h3 className="text-[14px] leading-snug font-semibold break-words text-ink">
          {question}
        </h3>
        <p className="mt-1 text-[11px] text-ink-3">
          {quiz
            ? "Host sees the correct answer marked · attendees won’t"
            : "Single choice · attendees see this when you launch"}
        </p>
        <div className="mt-3 space-y-1.5">
          {(options.length > 0 ? options : ["Option A", "Option B"]).map(
            (option, i) => {
              const correct = quiz && correctIdx === i;
              const selected = !quiz && choice === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    if (!quiz) setChoice(i);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors ${
                    correct
                      ? "border-ok/50 bg-ok-soft text-ink"
                      : selected
                        ? "border-brand bg-brand-soft text-ink"
                        : "border-line-2 bg-surface-2 text-ink"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold ${
                      correct
                        ? "bg-ok text-stage"
                        : selected
                          ? "bg-brand text-stage"
                          : "bg-surface text-ink-2"
                    }`}
                  >
                    {correct || selected ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      letterFor(i)
                    )}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{option}</span>
                  {correct && (
                    <span className="shrink-0 text-[10px] font-bold tracking-wide text-ok uppercase">
                      Correct
                    </span>
                  )}
                </button>
              );
            },
          )}
        </div>
        <div className="mt-3">
          <span className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-brand text-[12.5px] font-semibold text-stage">
            {quiz ? "Submit answer" : "Submit"}
          </span>
        </div>
      </div>
    </div>
  );
}
