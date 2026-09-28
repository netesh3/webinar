"use client";

import type { ReactNode } from "react";
import { Button } from "../ui";
import { FormGroup } from "./chrome";
import type { FormState } from "./form-state";
import type { FollowUpSummary } from "./action-bar";
import type { Step } from "./stepper";

/* The last step: everything the host set, in one place, each with a way back
 * to it. It reads the same form state the other steps write, so nothing here
 * can disagree with what Schedule sends. */
export function ReviewStep({
  form,
  when,
  surveyOn,
  followUps,
  hasImage,
  onStep,
}: {
  form: FormState;
  when: string | null;
  surveyOn: boolean;
  followUps: FollowUpSummary;
  hasImage: boolean;
  onStep: (step: Step) => void;
}) {
  const panelists = form.panelistEmails
    .split(/[\n,;]/)
    .map((e) => e.trim())
    .filter(Boolean);
  const questions = form.questions.filter((q) => q.label.trim() !== "");
  const room = (
    [
      ["chatEnabled", "Chat"],
      ["qaEnabled", "Q&A"],
      ["reactionsEnabled", "Reactions"],
      ["raiseHandEnabled", "Raise hand"],
    ] as const
  )
    .filter(([key]) => form.controls[key])
    .map(([, label]) => label);
  const extras = (
    [
      ["autoRecord", "Auto-record"],
      ["captions", "Captions"],
      ["multistream", "YouTube / LinkedIn stream"],
    ] as const
  )
    .filter(([key]) => form.options[key])
    .map(([, label]) => label);

  return (
    <div className="grid gap-5">
      <FormGroup label="Review">
        <dl className="divide-y divide-line">
          <Row label="Topic" step="details" onStep={onStep}>
            {form.topic.trim() || (
              <span className="text-live">Not set — a topic is required</span>
            )}
            {form.summary.trim() && (
              <span className="block text-ink-3">{form.summary}</span>
            )}
          </Row>
          <Row label="Cover" step="details" onStep={onStep}>
            {hasImage ? "Your image" : "Generated from the topic"}
          </Row>
          <Row label="When" step="details" onStep={onStep}>
            {when ?? <span className="text-live">Pick a valid date and time</span>}
            <span className="block text-ink-3">{form.timeZone}</span>
          </Row>
          <Row label="Type" step="details" onStep={onStep}>
            {form.kind === "recurring"
              ? "Recurring series"
              : form.kind === "simulive"
                ? "Simulive"
                : "Live webinar"}
            {form.track.trim() && ` · ${form.track.trim()}`}
          </Row>
          <Row label="Registration" step="details" onStep={onStep}>
            {form.registrationRequired
              ? `Required · ${form.approval === "manual" ? "manual approval" : "auto-approve"}`
              : "Not required"}
            {` · ${form.attendeeLimit.toLocaleString()} seats`}
            {form.passcode.trim() && " · passcode set"}
            <span className="block text-ink-3">
              {questions.length === 0
                ? "Name and email only"
                : `Name, email and ${questions.length} question${questions.length === 1 ? "" : "s"}`}
            </span>
          </Row>
          <Row label="The room" step="details" onStep={onStep}>
            {room.length ? room.join(", ") : "Chat, Q&A, reactions and hands off"}
            {extras.length > 0 && (
              <span className="block text-ink-3">{extras.join(", ")}</span>
            )}
          </Row>
          <Row label="Panelists" step="details" onStep={onStep}>
            {panelists.length ? panelists.join(", ") : "Just you"}
          </Row>
          <Row label="Feedback" step="survey" onStep={onStep}>
            {surveyOn ? "Survey on" : "No survey"}
          </Row>
          <Row label="Follow-ups" step="followups" onStep={onStep}>
            {followUps == null
              ? "Loading…"
              : followUps === "failed"
                ? "Couldn't load — open Follow-ups to retry"
                : `${followUps.enabled} message${followUps.enabled === 1 ? "" : "s"} on · ${followUps.custom ? "customised for this webinar" : "your defaults"}`}
          </Row>
        </dl>
      </FormGroup>
    </div>
  );
}

function Row({
  label,
  step,
  onStep,
  children,
}: {
  label: string;
  step: Step;
  onStep: (step: Step) => void;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 lg:px-5">
      <dt className="text-[12.5px] font-medium text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[13px] text-ink">{children}</dd>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-my-1"
        onClick={() => onStep(step)}
      >
        Edit
      </Button>
    </div>
  );
}
