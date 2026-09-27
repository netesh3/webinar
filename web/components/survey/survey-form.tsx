"use client";

import { useId, useState } from "react";
import { api } from "@/lib/api";
import type { AudienceSurvey, MySurveyResponse, Survey, SurveyQuestion } from "@/lib/api-types";
import {
  DEFAULT_BUTTON,
  DEFAULT_TITLE,
  asksRating,
  draftProblem,
  emptyDraft,
  toAnswers,
  type Draft,
} from "@/lib/survey";
import { Alert, Spinner } from "../controls";
import { CheckIcon, ClipboardIcon, CloseIcon, ExternalLinkIcon } from "../icons";
import { OptionChoice } from "../room/poll-popup";
import { NpsScale, StarRating, TextAnswer } from "./survey-inputs";

/* The survey an attendee fills in: the same body in the room's pop-up, on the "webinar has
 * ended" and "you left" screens, and in the host's preview.
 *
 * It owns the draft and the two requests (submit, and "they opened the link"). Where it sits
 * and when it goes away belong to the caller. `preview` swaps the requests for a no-op so the
 * host can click through exactly what the audience will see without answering their own
 * survey. */

export interface SurveyFormProps {
  survey: Survey;
  mine: MySurveyResponse;
  slug: string;
  joinKey?: string;
  preview?: boolean;
  /** No requests, but the attendee's copy: design review (/mock/survey). */
  offline?: boolean;
  /** Open on the thank-you state, for design review. */
  startThanked?: boolean;
  /** "Maybe later" / close. Absent hides both. */
  onLater?: () => void;
  laterLabel?: string;
  /** The server's copy after a submit or a click. */
  onChange?: (next: AudienceSurvey) => void;
  onDone?: () => void;
  titleId?: string;
}

export function SurveyForm({
  survey,
  mine,
  slug,
  joinKey,
  preview,
  offline = preview,
  startThanked = false,
  onLater,
  laterLabel = "Maybe later",
  onChange,
  onDone,
  titleId: givenTitleId,
}: SurveyFormProps) {
  const autoId = useId();
  const titleId = givenTitleId ?? `${autoId}-title`;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(startThanked);
  const [opened, setOpened] = useState(mine.linkClicked);

  const rating = asksRating(survey);
  const link = survey.mode === "link";
  const problem = draftProblem(survey, draft);
  const needsSubmit = rating || (!link && survey.questions.length > 0);

  function report(next: Partial<MySurveyResponse>) {
    onChange?.({ survey, live: true, mine: { ...mine, ...next } });
  }

  function openLink() {
    setOpened(true);
    if (offline) return;
    // Recorded after the tab opens, never before: the new tab is the thing they asked for,
    // and a slow request must not stand between them and it.
    void api.surveyClick(slug, { joinKey }).catch(() => undefined);
    if (!rating) {
      report({ linkClicked: true });
    }
  }

  async function submit() {
    if (problem || sending) return;
    if (offline) {
      setThanks(true);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const next = await api.submitSurvey(slug, {
        joinKey,
        rating: rating ? (draft.rating ?? undefined) : undefined,
        answers: toAnswers(survey, draft),
      });
      setThanks(true);
      onChange?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your feedback didn't go through. Try again.");
    } finally {
      setSending(false);
    }
  }

  if (thanks) {
    return <ThankYou titleId={titleId} onDone={onDone ?? onLater} preview={preview} />;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
          <ClipboardIcon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center rounded-full border border-brand-line bg-brand-soft px-2 text-[10.5px] leading-5 font-semibold tracking-[0.06em] text-brand uppercase">
            {preview ? "Preview" : "Quick survey"}
          </span>
          <p className="mt-1 text-[12px] text-ink-3">
            {link ? "The host would like your feedback" : "Takes about 30 seconds"}
          </p>
        </div>
        {onLater && (
          <button
            type="button"
            onClick={onLater}
            aria-label={`Close — ${laterLabel.toLowerCase()}`}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <CloseIcon className="size-4" />
          </button>
        )}
      </div>

      <h2
        id={titleId}
        className="mt-4 text-[17px] leading-snug font-semibold break-words wrap-anywhere text-ink sm:text-[18px]"
      >
        {survey.title || DEFAULT_TITLE}
      </h2>

      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {rating && (
        <div className="mt-4 rounded-xl border border-line bg-surface-2/40 px-3 pt-4 pb-2">
          <p id={`${titleId}-rating`} className="sr-only">
            Rate this session from 1 to 5 stars
          </p>
          <StarRating
            name={`${autoId}-rating`}
            value={draft.rating}
            onChange={(n) => setDraft((d) => ({ ...d, rating: n }))}
            disabled={sending}
            labelledBy={`${titleId}-rating`}
          />
        </div>
      )}

      {!link && survey.questions.length > 0 && (
        <div className="mt-5 space-y-5">
          {survey.questions.map((q) => (
            <QuestionField
              key={q.id}
              question={q}
              baseId={autoId}
              value={draft.answers[q.id]}
              disabled={sending}
              onChange={(v) => setDraft((d) => ({ ...d, answers: { ...d.answers, [q.id]: v } }))}
            />
          ))}
        </div>
      )}

      {link && (
        <div className="mt-4">
          <a
            href={survey.externalUrl || undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={openLink}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-brand-line bg-brand-soft text-[13.5px] font-semibold text-brand transition-colors hover:bg-brand/15 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {survey.buttonLabel || DEFAULT_BUTTON}
            <ExternalLinkIcon className="size-4" />
          </a>
          <p className="mt-2 flex items-center justify-center gap-1.5 text-[11.5px] text-ink-3">
            {opened ? (
              <>
                <CheckIcon className="size-3.5 text-ok" /> Opened in a new tab
              </>
            ) : (
              <>Opens in a new tab{hostOf(survey.externalUrl) ? ` · ${hostOf(survey.externalUrl)}` : ""}</>
            )}
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        {onLater && (
          <button
            type="button"
            onClick={onLater}
            disabled={sending}
            className="inline-flex h-11 items-center justify-center rounded-lg px-4 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:h-10"
          >
            {needsSubmit ? laterLabel : "Close"}
          </button>
        )}
        {needsSubmit && (
          <button
            type="submit"
            disabled={Boolean(problem) || sending}
            title={problem ?? undefined}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand text-[13.5px] font-semibold text-stage shadow-sm transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:h-10 sm:w-auto sm:flex-1"
          >
            {sending && <Spinner className="size-4" />}
            {sending ? "Sending…" : link ? "Submit rating" : "Send feedback"}
          </button>
        )}
      </div>
      {needsSubmit && (
        <p className="mt-3 text-center text-[11.5px] leading-relaxed text-ink-3">
          {problem && !sending ? problem : "Only the host sees your answers."}
        </p>
      )}
    </form>
  );
}

function QuestionField({
  question: q,
  baseId,
  value,
  disabled,
  onChange,
}: {
  question: SurveyQuestion;
  baseId: string;
  value: number | string | undefined;
  disabled: boolean;
  onChange: (v: number | string) => void;
}) {
  const labelId = `${baseId}-${q.id}-label`;
  const name = `${baseId}-${q.id}`;
  return (
    <div>
      <p id={labelId} className="mb-2 text-[13.5px] leading-snug font-medium break-words wrap-anywhere text-ink">
        {q.prompt}
        <span className="ml-1.5 text-[11.5px] font-normal text-ink-3">{q.required ? "Required" : "Optional"}</span>
      </p>
      {q.kind === "rating_5" && (
        <StarRating
          name={name}
          size="md"
          value={typeof value === "number" ? value : null}
          onChange={onChange}
          disabled={disabled}
          labelledBy={labelId}
        />
      )}
      {q.kind === "nps_10" && (
        <NpsScale
          name={name}
          value={typeof value === "number" ? value : null}
          onChange={onChange}
          disabled={disabled}
          labelledBy={labelId}
        />
      )}
      {q.kind === "single_choice" && (
        <div role="radiogroup" aria-labelledby={labelId} className="space-y-1.5">
          {q.options.map((option, i) => (
            <OptionChoice
              key={i}
              name={name}
              index={i}
              label={option}
              selected={value === i}
              disabled={disabled}
              onPick={() => onChange(i)}
            />
          ))}
        </div>
      )}
      {q.kind === "text" && (
        <TextAnswer
          id={name}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          disabled={disabled}
          labelledBy={labelId}
        />
      )}
    </div>
  );
}

function ThankYou({ titleId, onDone, preview }: { titleId: string; onDone?: () => void; preview?: boolean }) {
  return (
    <div className="flex flex-col items-center py-4 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-ok-soft text-ok motion-safe:animate-[poll-card-in_320ms_cubic-bezier(0.2,0.9,0.3,1.15)]">
        <CheckIcon className="size-7" />
      </span>
      <h2 id={titleId} className="mt-4 text-[17px] font-semibold text-ink">
        Thanks for your feedback
      </h2>
      <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-ink-2">
        {preview
          ? "This is what attendees see after they submit. Nothing was recorded."
          : "Your answers help the host make the next session better."}
      </p>
      {onDone && (
        <button
          type="button"
          onClick={onDone}
          autoFocus
          className="mt-5 inline-flex h-10 items-center justify-center rounded-lg border border-line-2 px-5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          Done
        </button>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
