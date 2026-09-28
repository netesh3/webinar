"use client";

import { Select, Toggle } from "../controls";
import { PlusIcon, TrashIcon } from "../icons";
import { useAppConfig } from "../providers";
import { Button } from "../ui";
import type { CustomQuestion } from "@/lib/api-types";
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
                placeholder="Question label"
                value={q.label}
                onChange={(e) => update(i, { label: e.target.value })}
                aria-label={`Question ${i + 1} label`}
              />
              <select
                className="field h-9 w-[112px] text-[12.5px]"
                value={q.type}
                onChange={(e) => update(i, { type: e.target.value })}
                aria-label={`Question ${i + 1} type`}
              >
                <option value="short">Short text</option>
                <option value="select">Choose one</option>
                <option value="checkbox">Checkbox</option>
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
              <input
                className="field mt-2 h-9 text-[12.5px]"
                placeholder="Options, comma separated"
                value={(q.options ?? []).join(", ")}
                onChange={(e) =>
                  update(i, {
                    options: e.target.value
                      .split(",")
                      .map((o) => o.trim())
                      .filter(Boolean),
                  })
                }
                aria-label={`Question ${i + 1} options`}
              />
            )}

            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
              <input
                type="checkbox"
                className="size-3.5 accent-brand"
                checked={q.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              Required
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
