"use client";

import { useState } from "react";
import type { PollInput } from "@/lib/api-types";
import {
  MAX_OPTION,
  MAX_OPTIONS,
  MAX_QUESTION,
  buildPollInput,
  correctAfterRemove,
  letterFor,
  type ComposerDraft,
} from "@/lib/poll-view";
import { Alert, Spinner } from "../controls";
import { CheckIcon, CloseIcon, PlayIcon, PlusIcon } from "../icons";

/** The host writing a question — new, or an edit of a draft.
 *
 *  Two options to start, because a poll with one is not a poll. For a quiz, the
 *  letter badge on each row becomes the correct-answer picker, and marking one is
 *  required: a quiz with no right answer marks every response wrong, which the
 *  server refuses for the same reason.
 *
 *  `onSave` is handed the finished body and whether to launch it straight away; the
 *  caller owns the requests so a failure lands back here as `error`. */
export function Composer({
  initial,
  editing,
  liveQuestion,
  onSave,
  onCancel,
}: {
  initial?: ComposerDraft;
  editing: boolean;
  /** The question currently live, if any: launching this closes it. */
  liveQuestion: string | null;
  onSave: (input: PollInput, launch: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ComposerDraft>(
    () => initial ?? { question: "", options: ["", ""], quiz: false, correct: 0 },
  );
  const [saving, setSaving] = useState<"draft" | "launch" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const built = buildPollInput(draft);
  const set = (patch: Partial<ComposerDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function save(launch: boolean) {
    setTried(true);
    if (!built.ok || saving) return;
    setSaving(launch ? "launch" : "draft");
    setError(null);
    try {
      await onSave(built.input, launch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      aria-label={editing ? "Edit poll" : "New poll"}
      className="space-y-3 rounded-xl border border-brand-line bg-surface p-3 shadow-[0_0_0_1px_var(--color-brand-line)]"
    >
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[12.5px] font-semibold text-ink">
          {editing ? "Edit draft" : "New question"}
        </p>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="grid size-8 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>

      {/* Poll or quiz, as a segmented control: it changes what the rows below mean,
          so it sits above them rather than as a toggle at the bottom. */}
      <div role="radiogroup" aria-label="Type" className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
        {(
          [
            [false, "Poll", "Opinions, no right answer"],
            [true, "Quiz", "One option is correct"],
          ] as const
        ).map(([quiz, label, hint]) => {
          const on = draft.quiz === quiz;
          return (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => set({ quiz })}
              // Selection is the brand border + tint; keyboard focus is a separate
              // offset outline in ink, so the two never read as the same thing.
              className={`min-w-0 rounded-md border px-2 py-1.5 text-left transition-colors duration-150 motion-reduce:transition-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                on
                  ? "border-brand bg-brand-soft"
                  : "border-transparent text-ink-2 hover:border-line-2 hover:bg-surface hover:text-ink"
              }`}
            >
              <span className={`block text-[12.5px] font-semibold ${on ? "text-brand" : ""}`}>{label}</span>
              <span className={`block text-[10.5px] ${on ? "text-ink-2" : "text-ink-3"}`}>{hint}</span>
            </button>
          );
        })}
      </div>

      <div>
        <textarea
          className="field min-h-[4.25rem] resize-none py-2 text-[13px] leading-snug"
          placeholder={draft.quiz ? "Ask your quiz question…" : "What do you want to ask the room?"}
          maxLength={MAX_QUESTION}
          rows={2}
          value={draft.question}
          onChange={(e) => set({ question: e.target.value })}
          aria-label="Question"
          autoFocus
        />
        <p className="mt-0.5 text-right text-[10.5px] tabular-nums text-ink-3">
          {draft.question.length}/{MAX_QUESTION}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="flex items-center text-[11px] font-medium text-ink-2">
          <span className="flex-1">Options</span>
          {draft.quiz && <span className="text-[10.5px] text-ink-3">Tap a letter to mark the answer</span>}
        </p>
        {draft.options.map((option, i) => {
          const correct = draft.quiz && draft.correct === i;
          return (
            <div key={i} className="flex items-center gap-1.5">
              {draft.quiz ? (
                <button
                  type="button"
                  role="radio"
                  aria-checked={correct}
                  onClick={() => set({ correct: i })}
                  aria-label={`Option ${letterFor(i)} is the correct answer`}
                  title={correct ? "Correct answer" : "Mark as the correct answer"}
                  className={`grid size-8 shrink-0 place-items-center rounded-lg border text-[11.5px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ok/40 ${
                    correct
                      ? "border-ok bg-ok text-stage"
                      : "border-line-2 text-ink-2 hover:border-ok/50 hover:text-ok"
                  }`}
                >
                  {correct ? <CheckIcon className="size-3.5" /> : letterFor(i)}
                </button>
              ) : (
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-[11.5px] font-semibold text-ink-2"
                >
                  {letterFor(i)}
                </span>
              )}
              <input
                className={`field h-9 flex-1 text-[12.5px] ${correct ? "border-ok/50" : ""}`}
                placeholder={`Option ${letterFor(i)}`}
                maxLength={MAX_OPTION}
                value={option}
                onChange={(e) =>
                  set({ options: draft.options.map((v, j) => (j === i ? e.target.value : v)) })
                }
                aria-label={`Option ${letterFor(i)}`}
              />
              {draft.options.length > 2 && (
                <button
                  type="button"
                  onClick={() =>
                    // The correct answer follows its option, not whichever one
                    // slides into its index.
                    set({
                      options: draft.options.filter((_, j) => j !== i),
                      correct: correctAfterRemove(draft.correct, i),
                    })
                  }
                  aria-label={`Remove option ${letterFor(i)}`}
                  className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-live outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <CloseIcon className="size-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {draft.options.length < MAX_OPTIONS ? (
          <button
            type="button"
            onClick={() => set({ options: [...draft.options, ""] })}
            className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <PlusIcon className="size-3.5" />
            Add option
            <span className="text-[10.5px] font-normal text-ink-3 tabular-nums">
              {draft.options.length}/{MAX_OPTIONS}
            </span>
          </button>
        ) : (
          <p className="text-[11px] text-ink-3">That&apos;s the maximum of {MAX_OPTIONS} options.</p>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-ink-3">
        Attendees see the question and options only — never the counts, so nobody can see
        which way the room is going before they answer.
        {draft.quiz && " They find out whether they were right when you close voting."}
      </p>

      {error && <Alert tone="error">{error}</Alert>}
      {tried && !built.ok && !error && <p className="text-[11.5px] font-medium text-warn">{built.reason}</p>}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
        <button
          type="button"
          onClick={() => void save(true)}
          disabled={saving !== null}
          title={liveQuestion ? `Launching closes “${liveQuestion}”` : undefined}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-[12.5px] font-semibold text-stage transition-colors hover:bg-brand-hover disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {saving === "launch" ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          {editing ? "Save & launch" : "Launch now"}
        </button>
        <button
          type="submit"
          disabled={saving !== null}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {saving === "draft" && <Spinner className="size-3.5" />}
          {editing ? "Save draft" : "Save as draft"}
        </button>
        {liveQuestion && (
          <p className="basis-full text-[10.5px] text-ink-3">
            Only one question is live at a time — launching this closes the current one.
          </p>
        )}
      </div>
    </form>
  );
}
