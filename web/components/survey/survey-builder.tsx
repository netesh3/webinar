"use client";

import { useId } from "react";
import type { SurveyInput, SurveyQuestionInput, SurveyQuestionKind } from "@/lib/api-types";
import {
  DEFAULT_BUTTON,
  DEFAULT_TITLE,
  KIND_LABELS,
  LIMITS,
  SEND_CHOICES,
  blankQuestion,
  moveItem,
  suggestedSendMinute,
} from "@/lib/survey";
import { Toggle } from "../controls";
import { ArrowDownIcon, ArrowUpIcon, ExternalLinkIcon, PlusIcon, StarIcon, TrashIcon } from "../icons";

/* The host's survey builder: a controlled form over SurveyInput.
 *
 * Kept deliberately small. Two modes, one screen each; at most five extra questions of four
 * kinds; every limit the server enforces is shown before it is hit. `locked` (somebody has
 * answered) freezes everything that would change what an answer meant — mode, the rating
 * toggle, the questions — and leaves the wording of the card editable. */

export function SurveyBuilder({
  value,
  onChange,
  errors,
  locked,
  durationMin = 60,
}: {
  value: SurveyInput;
  onChange: (next: SurveyInput) => void;
  errors: Record<string, string>;
  locked: boolean;
  /** The webinar's scheduled length, for the "at a set time" suggestion. */
  durationMin?: number;
}) {
  const id = useId();
  const set = (patch: Partial<SurveyInput>) => onChange({ ...value, ...patch });
  const setQ = (i: number, patch: Partial<SurveyQuestionInput>) =>
    set({ questions: value.questions.map((q, n) => (n === i ? { ...q, ...patch } : q)) });
  const link = value.mode === "link";

  return (
    <div className="grid gap-5">
      <fieldset disabled={locked}>
        <legend className="label">Survey type</legend>
        <div role="radiogroup" aria-label="Survey type" className="grid gap-2 sm:grid-cols-2">
          <ModeCard
            active={!link}
            onPick={() => set({ mode: "builtin" })}
            icon={<StarIcon className="size-[18px]" />}
            title="Rating survey"
            body="1–5 stars plus a few short questions, answered right in the webinar."
          />
          <ModeCard
            active={link}
            onPick={() => set({ mode: "link" })}
            icon={<ExternalLinkIcon className="size-[18px]" />}
            title="Survey link"
            body="Send people to your Google Form, Typeform or any https:// survey."
          />
        </div>
        {locked && (
          <p className="mt-2 text-[12px] text-ink-3">
            People have answered, so the type and questions are fixed. You can still reword the title and button.
          </p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          id={`${id}-title`}
          label="Title"
          value={value.title}
          placeholder={DEFAULT_TITLE}
          max={LIMITS.title}
          error={errors.title}
          onChange={(title) => set({ title })}
        />
        {link && (
          <TextInput
            id={`${id}-button`}
            label="Button label"
            value={value.buttonLabel}
            placeholder={DEFAULT_BUTTON}
            max={LIMITS.button}
            error={errors.buttonLabel}
            onChange={(buttonLabel) => set({ buttonLabel })}
          />
        )}
      </div>

      {link ? (
        <>
          <TextInput
            id={`${id}-url`}
            label="Survey link"
            type="url"
            value={value.externalUrl}
            placeholder="https://forms.gle/…"
            max={LIMITS.url}
            error={errors.externalUrl}
            hint="Opens in a new tab. Only https:// links are accepted."
            onChange={(externalUrl) => set({ externalUrl })}
          />
          <div className="rounded-lg border border-line px-2">
            <Toggle
              checked={value.askRating}
              disabled={locked}
              onChange={(askRating) => set({ askRating })}
              label="Also ask for a 1–5 star rating"
              description="Keeps your session ratings comparable across webinars, whatever the external form asks."
            />
          </div>
        </>
      ) : (
        <QuestionList value={value} locked={locked} errors={errors} set={set} setQ={setQ} />
      )}

      <fieldset>
        <legend className="label">When attendees see it</legend>
        <div role="radiogroup" aria-label="When attendees see it" className="grid gap-2">
          {SEND_CHOICES.map((c) => (
            <SendCard
              key={c.id}
              active={value.sendAt === c.id}
              onPick={() =>
                set({
                  sendAt: c.id,
                  sendAfterMin:
                    c.id === "at_minute" && !value.sendAfterMin
                      ? suggestedSendMinute(durationMin)
                      : value.sendAfterMin,
                })
              }
              title={c.title}
              body={c.body}
              recommended={c.recommended}
            >
              {c.id === "at_minute" && value.sendAt === "at_minute" && (
                <span className="mt-2.5 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                  <label htmlFor={`${id}-minute`}>Pop up</label>
                  <input
                    id={`${id}-minute`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={LIMITS.sendAfterMin}
                    value={value.sendAfterMin || ""}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    onChange={(e) => set({ sendAfterMin: Math.trunc(Number(e.target.value)) || 0 })}
                    aria-invalid={Boolean(errors.sendAfterMin)}
                    className={`field h-8 w-20 py-1 text-center tabular-nums ${errors.sendAfterMin ? "border-live/60" : ""}`}
                  />
                  <span>minutes after you go live</span>
                  {durationMin > 0 && (
                    <span className="text-ink-3">· the session is {durationMin} min</span>
                  )}
                </span>
              )}
            </SendCard>
          ))}
        </div>
        {errors.sendAfterMin && <p className="mt-1.5 text-[12px] text-live">{errors.sendAfterMin}</p>}
        <p className="mt-2 text-[11.5px] text-ink-3">
          Whichever you pick, you can still send it earlier from the room, and anyone who leaves
          early is asked on the way out.
        </p>
      </fieldset>
    </div>
  );
}

function QuestionList({
  value,
  locked,
  errors,
  set,
  setQ,
}: {
  value: SurveyInput;
  locked: boolean;
  errors: Record<string, string>;
  set: (patch: Partial<SurveyInput>) => void;
  setQ: (i: number, patch: Partial<SurveyQuestionInput>) => void;
}) {
  const full = value.questions.length >= LIMITS.questions;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label mb-0">Questions</span>
        <span className="text-[11.5px] text-ink-3 tabular-nums">
          {value.questions.length} / {LIMITS.questions} extra
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">
        <span className="flex gap-0.5 text-warn" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <StarIcon key={i} className="size-4 fill-warn" />
          ))}
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-ink">
          Overall rating, 1–5 stars <span className="text-ink-3">· always asked, required</span>
        </span>
      </div>
      {errors.questions && <p className="mt-2 text-[12px] text-live">{errors.questions}</p>}
      <ol className="mt-2 grid gap-2">
        {value.questions.map((q, i) => (
          <li key={q.id ?? `new-${i}`}>
            <QuestionEditor
              index={i}
              count={value.questions.length}
              question={q}
              locked={locked}
              error={errors[`questions.${i}`]}
              onChange={(patch) => setQ(i, patch)}
              onMove={(to) => set({ questions: moveItem(value.questions, i, to) })}
              onRemove={() => set({ questions: value.questions.filter((_, n) => n !== i) })}
            />
          </li>
        ))}
      </ol>
      {!locked && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(["nps_10", "text", "single_choice", "rating_5"] as SurveyQuestionKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={full}
              onClick={() => set({ questions: [...value.questions, blankQuestion(kind)] })}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-line-2 px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-brand hover:text-brand disabled:pointer-events-none disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <PlusIcon className="size-3.5" />
              {KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionEditor({
  index,
  count,
  question: q,
  locked,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  question: SurveyQuestionInput;
  locked: boolean;
  error?: string;
  onChange: (patch: Partial<SurveyQuestionInput>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const options = q.options ?? [];
  return (
    <fieldset
      disabled={locked}
      className={`rounded-lg border bg-surface p-3 ${error ? "border-live/50" : "border-line"}`}
    >
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">
          {KIND_LABELS[q.kind] ?? q.kind}
        </span>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-2">
          <input
            type="checkbox"
            checked={q.required}
            onChange={(e) => onChange({ required: e.target.checked })}
            className="size-3.5 accent-[var(--color-brand)]"
          />
          Required
        </label>
        {!locked && (
          <span className="flex items-center">
            <IconBtn label="Move up" disabled={index === 0} onClick={() => onMove(index - 1)}>
              <ArrowUpIcon className="size-3.5" />
            </IconBtn>
            <IconBtn label="Move down" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
              <ArrowDownIcon className="size-3.5" />
            </IconBtn>
            <IconBtn label="Remove question" onClick={onRemove}>
              <TrashIcon className="size-3.5" />
            </IconBtn>
          </span>
        )}
      </div>
      <label htmlFor={`${id}-prompt`} className="sr-only">
        Question {index + 1}
      </label>
      <input
        id={`${id}-prompt`}
        className="field mt-2"
        value={q.prompt}
        maxLength={LIMITS.prompt}
        placeholder="Ask something…"
        onChange={(e) => onChange({ prompt: e.target.value })}
      />
      {q.kind === "single_choice" && (
        <div className="mt-2 grid gap-1.5">
          {options.map((o, n) => (
            <div key={n} className="flex items-center gap-1.5">
              <span className="w-5 text-center text-[11.5px] font-semibold text-ink-3">
                {String.fromCharCode(65 + n)}
              </span>
              <input
                className="field h-9 py-1.5 text-[13px]"
                value={o}
                maxLength={LIMITS.option}
                aria-label={`Option ${n + 1}`}
                placeholder={`Option ${n + 1}`}
                onChange={(e) => onChange({ options: options.map((x, k) => (k === n ? e.target.value : x)) })}
              />
              {!locked && options.length > 2 && (
                <IconBtn label={`Remove option ${n + 1}`} onClick={() => onChange({ options: options.filter((_, k) => k !== n) })}>
                  <TrashIcon className="size-3.5" />
                </IconBtn>
              )}
            </div>
          ))}
          {!locked && options.length < LIMITS.options && (
            <button
              type="button"
              onClick={() => onChange({ options: [...options, ""] })}
              className="ml-6 inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-brand hover:bg-brand-soft"
            >
              <PlusIcon className="size-3.5" /> Add option
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-live">{error}</p>}
    </fieldset>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      {children}
    </button>
  );
}

function TextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  max,
  error,
  hint,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  max: number;
  error?: string;
  hint?: string;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className={`field ${error ? "border-live/60" : ""}`}
        value={value}
        placeholder={placeholder}
        maxLength={max}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? `${id}-note` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {(error || hint) && (
        <p id={`${id}-note`} className={`mt-1 text-[11.5px] ${error ? "text-live" : "text-ink-3"}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

function ModeCard({
  active,
  onPick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onPick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? "border-brand bg-brand-soft shadow-[0_0_0_1px_var(--color-brand)]" : "border-line hover:border-line-2 hover:bg-surface-2"
      }`}
    >
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-lg ${
          active ? "bg-brand text-white" : "bg-surface-2 text-ink-2"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ink-2">{body}</span>
      </span>
    </button>
  );
}

function SendCard({
  active,
  onPick,
  title,
  body,
  recommended,
  children,
}: {
  active: boolean;
  onPick: () => void;
  title: string;
  body: string;
  recommended?: boolean;
  children?: React.ReactNode;
}) {
  // A div with radio semantics rather than a <button>: the minute field sits inside it.
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={active}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onPick();
        }
      }}
      className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        active ? "border-brand bg-brand-soft" : "border-line hover:border-line-2 hover:bg-surface-2"
      }`}
    >
      <span
        aria-hidden
        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2 ${
          active ? "border-brand" : "border-line-2"
        }`}
      >
        {active && <span className="size-2 rounded-full bg-brand" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-ink">
          {title}
          {recommended && (
            <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-ok uppercase">
              Recommended
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ink-2">{body}</span>
        {children}
      </span>
    </div>
  );
}
