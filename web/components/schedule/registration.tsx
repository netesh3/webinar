"use client";

import { Select, Toggle } from "../controls";
import { PlusIcon, TrashIcon } from "../icons";
import { useAppConfig } from "../providers";
import { Button } from "../ui";
import type { CustomQuestion } from "@/lib/api-types";
import {
  MIN_OPTIONS,
  QUESTION_TYPES,
  optionsProblem,
  withType,
} from "@/lib/registration-questions";
import { Boxed, FormGroup, FormSection, Text } from "./chrome";
import { limitOptions, type FormState, type SetForm } from "./form-state";

export function RegistrationSection({
  form,
  set,
  fields,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
}) {
  const config = useAppConfig();
  return (
    <FormGroup label="Registration">
      <FormSection
        title="Who can join"
        description="Who gets in, and what you ask them first."
        first
      >
        <div className="grid gap-3.5">
          <Boxed on={form.registrationRequired}>
            <Toggle
              checked={form.registrationRequired}
              onChange={(v) => set("registrationRequired", v)}
              label="Require registration"
              description="Attendees fill in a form and get a personal join link. Signed-in accounts get it on their account instead."
            />
          </Boxed>

          <div className="grid gap-3.5 lg:grid-cols-3">
            <Select
              label="Approval"
              value={form.approval}
              onChange={(v) => set("approval", v as FormState["approval"])}
              hint={
                form.approval === "manual"
                  ? "Registrants wait in a queue until you approve them."
                  : undefined
              }
            >
              <option value="automatic">Automatically approve</option>
              <option value="manual">Manually approve each one</option>
            </Select>

            <Select
              id="limit"
              label="Attendee limit"
              value={String(form.attendeeLimit)}
              onChange={(v) => set("attendeeLimit", Number(v))}
              hint={
                config.maxAttendees
                  ? `This server is sized for up to ${config.maxAttendees.toLocaleString()} concurrent attendees.`
                  : undefined
              }
            >
              {limitOptions(config.maxAttendees, form.attendeeLimit).map(
                (n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()} attendees
                  </option>
                ),
              )}
            </Select>

            <Text
              label="Passcode (optional)"
              value={form.passcode}
              onChange={(v) => set("passcode", v)}
              hint="Shown alongside the webinar ID for anyone dialling in from a calendar invite."
              error={fields.passcode}
            />
          </div>

          {fields.customQuestions && (
            <p className="text-[12px] font-medium text-live">
              {fields.customQuestions}
            </p>
          )}

          <QuestionEditor
            questions={form.questions}
            onChange={(q) => set("questions", q)}
          />
        </div>
      </FormSection>
    </FormGroup>
  );
}

function QuestionEditor({
  questions,
  onChange,
}: {
  questions: CustomQuestion[];
  onChange: (next: CustomQuestion[]) => void;
}) {
  function update(index: number, patch: Partial<CustomQuestion>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  return (
    <div>
      <span className="label">
        Registration questions{" "}
        <span className="font-normal text-ink-3">
          · name and email are always asked
        </span>
      </span>

      <div className="mt-2 grid gap-2">
        {questions.map((q, i) => (
          <div key={i} className="rounded-lg border border-line p-3">
            <div className="flex items-start gap-2">
              <input
                className="field h-9 flex-1 text-[13px]"
                placeholder={
                  q.type === "checkbox"
                    ? "Checkbox text, e.g. Send me the slides"
                    : "Question label"
                }
                value={q.label}
                onChange={(e) => update(i, { label: e.target.value })}
                aria-label={`Question ${i + 1} label`}
              />
              <select
                className="field h-9 w-[112px] text-[12.5px]"
                value={q.type}
                onChange={(e) =>
                  onChange(
                    questions.map((x, j) =>
                      j === i ? withType(x, e.target.value) : x,
                    ),
                  )
                }
                aria-label={`Question ${i + 1} type`}
              >
                {QUESTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onChange(questions.filter((_, j) => j !== i))}
                aria-label={`Remove question ${i + 1}`}
                className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-live-soft hover:text-live"
              >
                <TrashIcon className="size-4" />
              </button>
            </div>

            {q.type === "select" && (
              <OptionsEditor
                index={i}
                question={q}
                onChange={(options) => update(i, { options })}
              />
            )}

            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
              <input
                type="checkbox"
                className="size-3.5 accent-brand"
                checked={q.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              {q.type === "checkbox" ? "Must be ticked to register" : "Required"}
            </label>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2"
        onClick={() =>
          onChange([
            ...questions,
            // The key is derived from the label on the server, so it is left empty
            // here rather than asking a host to invent an identifier.
            { id: "", label: "", type: "short", required: false, options: [] },
          ])
        }
      >
        <PlusIcon className="size-3.5" />
        Add a question
      </Button>
    </div>
  );
}

/* One row per option rather than a comma-separated box: an option can contain a comma
 * ("Yes, and my team"), and the old box re-joined what it split on every keystroke, so a
 * trailing comma or space was eaten before the next option could be typed. */
function OptionsEditor({
  index,
  question,
  onChange,
}: {
  index: number;
  question: CustomQuestion;
  onChange: (options: string[]) => void;
}) {
  const options = question.options ?? [];
  const problem = question.label.trim() ? optionsProblem(question) : null;
  return (
    <div className="mt-2 grid gap-1.5 pl-3">
      {options.map((o, j) => (
        <div key={j} className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-3 shrink-0 rounded-full border border-line-2"
          />
          <input
            className="field h-8 flex-1 text-[12.5px]"
            placeholder={`Option ${j + 1}`}
            value={o}
            onChange={(e) =>
              onChange(options.map((x, k) => (k === j ? e.target.value : x)))
            }
            aria-label={`Question ${index + 1} option ${j + 1}`}
          />
          <button
            type="button"
            onClick={() => onChange(options.filter((_, k) => k !== j))}
            disabled={options.length <= MIN_OPTIONS}
            aria-label={`Remove option ${j + 1} from question ${index + 1}`}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-live-soft hover:text-live disabled:pointer-events-none disabled:opacity-30"
          >
            <TrashIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => onChange([...options, ""])}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline"
        >
          <PlusIcon className="size-3" />
          Add option
        </button>
        {problem && (
          <span className="text-[12px] font-medium text-live">{problem}</span>
        )}
      </div>
    </div>
  );
}
