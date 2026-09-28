"use client";

import { useId, type ReactNode } from "react";
import type {
  SurveyInput,
  SurveyQuestionInput,
  SurveyQuestionKind,
} from "@/lib/api-types";
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
import { InfoTip, Toggle } from "../controls";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MaterialIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
} from "../icons";

/* The host's survey builder: a controlled form over SurveyInput.
 *
 * Kept deliberately small. Two modes, one screen each; at most five extra questions of four
 * kinds; every limit the server enforces is shown before it is hit. `locked` (somebody has
 * answered) freezes everything that would change what an answer meant — mode, the rating
 * toggle, the questions — and leaves the wording of the card editable. */

const SEND_SHORT: Record<(typeof SEND_CHOICES)[number]["id"], string> = {
  manual: "I'll put it on screen",
  at_minute: "At a set time",
  on_end: "When I end",
};

const SEND_ICON: Record<(typeof SEND_CHOICES)[number]["id"], string> = {
  manual: "co_present",
  at_minute: "schedule",
  on_end: "call_end",
};

export function SurveyBuilder({
  value,
  onChange,
  errors,
  locked,
  durationMin = 60,
  aside,
}: {
  value: SurveyInput;
  onChange: (next: SurveyInput) => void;
  errors: Record<string, string>;
  locked: boolean;
  /** The webinar's scheduled length, for the "at a set time" suggestion. */
  durationMin?: number;
  /** Live preview, beside the questions. */
  aside?: ReactNode;
}) {
  const id = useId();
  const set = (patch: Partial<SurveyInput>) => onChange({ ...value, ...patch });
  const setQ = (i: number, patch: Partial<SurveyQuestionInput>) =>
    set({
      questions: value.questions.map((q, n) =>
        n === i ? { ...q, ...patch } : q,
      ),
    });
  const link = value.mode === "link";

  return (
    <div className="grid gap-3.5">
      <div className="grid items-start gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
        <Segmented
          label="Survey type"
          name={`${id}-mode`}
          value={value.mode}
          disabled={locked}
          onChange={(mode) => set({ mode: mode as SurveyInput["mode"] })}
          options={[
            {
              id: "builtin",
              label: "Rating survey",
              icon: "star",
              tip: "1–5 stars plus a few short questions, answered right in the webinar.",
            },
            {
              id: "link",
              label: "Survey link",
              icon: "open_in_new",
              tip: "Send people to your Google Form, Typeform or any https:// survey.",
            },
          ]}
        />
        <TextInput
          id={`${id}-title`}
          label="Title"
          compact
          value={value.title}
          placeholder={DEFAULT_TITLE}
          max={LIMITS.title}
          error={errors.title}
          onChange={(title) => set({ title })}
        />
      </div>
      {locked && (
        <p className="text-[12px] text-ink-3">
          People have answered, so the type and questions are fixed. You can
          still reword the title and button.
        </p>
      )}
      {link && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            id={`${id}-button`}
            label="Button label"
            value={value.buttonLabel}
            placeholder={DEFAULT_BUTTON}
            max={LIMITS.button}
            error={errors.buttonLabel}
            onChange={(buttonLabel) => set({ buttonLabel })}
          />
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
        </div>
      )}

      <Segmented
        label="When attendees see it"
        labelTip="Whichever you pick, you can still send it earlier from the room, and anyone who leaves early is asked on the way out."
        name={`${id}-when`}
        value={value.sendAt}
        onChange={(sendAt) =>
          set({
            sendAt: sendAt as SurveyInput["sendAt"],
            sendAfterMin:
              sendAt === "at_minute" && !value.sendAfterMin
                ? suggestedSendMinute(durationMin)
                : value.sendAfterMin,
          })
        }
        options={SEND_CHOICES.map((c) => ({
          id: c.id,
          label: SEND_SHORT[c.id],
          icon: SEND_ICON[c.id],
          tip: c.body,
          recommended: c.recommended,
        }))}
      />
      {value.sendAt === "at_minute" && (
        <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
          <label htmlFor={`${id}-minute`}>Pop up</label>
          <input
            id={`${id}-minute`}
            type="number"
            inputMode="numeric"
            min={1}
            max={LIMITS.sendAfterMin}
            value={value.sendAfterMin || ""}
            onChange={(e) =>
              set({ sendAfterMin: Math.trunc(Number(e.target.value)) || 0 })
            }
            aria-invalid={Boolean(errors.sendAfterMin)}
            className={`field h-8 w-20 py-1 text-center tabular-nums ${errors.sendAfterMin ? "border-live/60" : ""}`}
          />
          <span>minutes after you go live</span>
          {durationMin > 0 && (
            <span className="text-ink-3">
              · the session is {durationMin} min
            </span>
          )}
        </span>
      )}
      {errors.sendAfterMin && (
        <p className="text-[12px] text-live">{errors.sendAfterMin}</p>
      )}

      <div
        className={
          aside
            ? "grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_17.5rem]"
            : undefined
        }
      >
        <div className="grid gap-3">
          {link ? (
            <div className="rounded-lg border border-line px-2">
              <Toggle
                checked={value.askRating}
                disabled={locked}
                onChange={(askRating) => set({ askRating })}
                label="Also ask for a 1–5 star rating"
                description="Keeps your session ratings comparable across webinars, whatever the external form asks."
              />
            </div>
          ) : (
            <QuestionList
              value={value}
              locked={locked}
              errors={errors}
              set={set}
              setQ={setQ}
            />
          )}
        </div>
        {aside}
      </div>
    </div>
  );
}

function Segmented({
  label,
  labelTip,
  name,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  labelTip?: string;
  name: string;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  options: {
    id: string;
    label: string;
    tip: string;
    icon?: string;
    recommended?: boolean;
  }[];
}) {
  const labelId = useId();
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex h-4 items-center gap-1">
        <span className="label mb-0" id={labelId}>
          {label}
        </span>
        {labelTip && <InfoTip text={labelTip} />}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex h-[34px] w-fit max-w-full gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
      >
        {options.map((o) => {
          const active = value === o.id;
          return (
            <label
              key={o.id}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-2.5 text-[12.5px] leading-none whitespace-nowrap has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40 ${
                active
                  ? "bg-surface font-medium text-ink shadow-sm ring-1 ring-line"
                  : "text-ink-2"
              } ${disabled ? "pointer-events-none opacity-60" : ""}`}
            >
              <input
                type="radio"
                name={name}
                value={o.id}
                checked={active}
                disabled={disabled}
                onChange={() => onChange(o.id)}
                className="sr-only"
              />
              {o.icon && (
                <MaterialIcon
                  name={o.icon}
                  className={`size-4 shrink-0 !text-[16px] ${active ? "text-brand" : "text-ink-3"}`}
                  fill={active && o.icon === "star"}
                />
              )}
              {o.label}
              {o.recommended && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-ok ring-2 ring-ok-soft"
                  title="Recommended"
                />
              )}
              <InfoTip text={o.tip} />
            </label>
          );
        })}
      </div>
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
      <div className="mb-1.5 flex h-4 items-center justify-between">
        <span className="label mb-0">Questions</span>
        <span className="text-[11.5px] text-ink-3 tabular-nums">
          {value.questions.length} / {LIMITS.questions} extra
        </span>
      </div>
      <div className="flex h-9 items-center gap-2.5 rounded-lg border border-line bg-surface-2/60 px-3">
        <span className="flex gap-0.5 text-warn" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <StarIcon key={i} className="size-4 fill-warn" />
          ))}
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-ink">
          Overall rating, 1–5 stars{" "}
          <span className="text-ink-3">· always asked, required</span>
        </span>
      </div>
      {errors.questions && (
        <p className="mt-2 text-[12px] text-live">{errors.questions}</p>
      )}
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
              onMove={(to) =>
                set({ questions: moveItem(value.questions, i, to) })
              }
              onRemove={() =>
                set({ questions: value.questions.filter((_, n) => n !== i) })
              }
            />
          </li>
        ))}
      </ol>
      {!locked && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(
            [
              "nps_10",
              "text",
              "single_choice",
              "rating_5",
            ] as SurveyQuestionKind[]
          ).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={full}
              onClick={() =>
                set({ questions: [...value.questions, blankQuestion(kind)] })
              }
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
            <IconBtn
              label="Move up"
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              <ArrowUpIcon className="size-3.5" />
            </IconBtn>
            <IconBtn
              label="Move down"
              disabled={index === count - 1}
              onClick={() => onMove(index + 1)}
            >
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
                onChange={(e) =>
                  onChange({
                    options: options.map((x, k) =>
                      k === n ? e.target.value : x,
                    ),
                  })
                }
              />
              {!locked && options.length > 2 && (
                <IconBtn
                  label={`Remove option ${n + 1}`}
                  onClick={() =>
                    onChange({ options: options.filter((_, k) => k !== n) })
                  }
                >
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
  compact,
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
  /** Segmented-control height, for a field sharing a row with one. */
  compact?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="label flex h-4 items-center">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className={`field ${compact ? "h-[34px] text-[13.5px]" : ""} ${error ? "border-live/60" : ""}`}
        value={value}
        placeholder={placeholder}
        maxLength={max}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? `${id}-note` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {(error || hint) && (
        <p
          id={`${id}-note`}
          className={`mt-1 text-[11.5px] ${error ? "text-live" : "text-ink-3"}`}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
