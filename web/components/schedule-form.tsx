"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { Alert, Disclosure, Select, Spinner, Toggle } from "./controls";
import { useAppConfig, useToast } from "./providers";
import { Button, Card, SectionTitle } from "./ui";
import { PlusIcon, TrashIcon } from "./icons";
import { ApiError, api } from "@/lib/api";
import type {
  AgendaItem,
  CustomQuestion,
  SessionControls,
  Webinar,
  WebinarInput,
  WebinarOptions,
} from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import {
  instantToZoned,
  localTimeZone,
  timeZoneLabel,
  timeZoneNames,
  zonedToInstant,
} from "@/lib/format";

/* Schedule or edit a webinar.
 *
 * One form for both. PATCH has replace semantics on the server, which means this
 * form is responsible for sending back everything it is not editing — the agenda
 * carried in state below is exactly that: no editor would have quietly deleted it
 * on every save.
 */

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

/** Default start: tomorrow at 10:00 in the host's own zone.
 *
 *  Computed rather than a fixed date. A hardcoded default goes stale, and a
 *  webinar scheduled in the past cannot be registered for. */
function defaultWhen(): { date: string; time: string } {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const iso = new Date(
    Date.UTC(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 10, 0),
  ).toISOString();
  return { date: instantToZoned(iso, "UTC").date, time: "10:00" };
}

type FormState = {
  topic: string;
  summary: string;
  description: string;
  track: string;
  date: string;
  time: string;
  durationMin: number;
  timeZone: string;
  kind: WebinarInput["kind"];
  registrationRequired: boolean;
  approval: WebinarInput["approval"];
  attendeeLimit: number;
  passcode: string;
  panelistEmails: string;
  takeaways: string;
  questions: CustomQuestion[];
  agenda: AgendaItem[];
  options: WebinarOptions;
  controls: SessionControls;
};

/* The seat counts a coach may choose from.
 *
 * A dropdown rather than a free number field, because the number is a capacity decision and
 * the person scheduling has no way to know what this server can carry. A spinner invited
 * "2000" on a box whose sustained egress runs out around 100 — see docs/CAPACITY.md — and the
 * failure that produces is not a rejected form, it is everybody's video degrading twenty
 * minutes into the session.
 *
 * 50 first and default, deliberately. It used to default to the server ceiling, which meant
 * every webinar was provisioned for the largest audience the operator had ever configured
 * whether or not anybody expected one. Choosing more should be a decision, not the fallback.
 */
const ATTENDEE_LIMITS = [50, 100, 200, 300, 400, 500] as const;

export const DEFAULT_ATTENDEE_LIMIT = ATTENDEE_LIMITS[0];

/* Which of those to offer, given what this server admits to, and whatever the webinar already
 * has.
 *
 * Two things it must not do. It must not offer a count above MAX_ATTENDEES, because the API
 * silently clamps it and a coach would be told 500 while getting 100. And it must not drop the
 * value a webinar ALREADY holds: this form is also the edit form, and a limit set through the
 * API — or before this list existed — would otherwise be quietly rewritten to the nearest
 * option the first time somebody changed the title.
 */
function limitOptions(maxAttendees: number, current: number): number[] {
  const ceiling = maxAttendees > 0 ? maxAttendees : ATTENDEE_LIMITS[ATTENDEE_LIMITS.length - 1];
  const offered = ATTENDEE_LIMITS.filter((n) => n <= ceiling);
  const known: readonly number[] = ATTENDEE_LIMITS;
  const withCurrent =
    current > 0 && !known.includes(current) ? [...offered, current] : [...offered];
  return [...new Set(withCurrent)].sort((a, b) => a - b);
}

function initialState(webinar: Webinar | null, maxAttendees: number): FormState {
  if (webinar) {
    const when = instantToZoned(webinar.startsAt, webinar.timeZone);
    return {
      topic: webinar.topic,
      summary: webinar.summary,
      description: webinar.description,
      track: webinar.track,
      date: when.date,
      time: when.time,
      durationMin: webinar.durationMin,
      timeZone: webinar.timeZone,
      kind: webinar.kind,
      registrationRequired: webinar.registrationRequired,
      approval: webinar.approval,
      attendeeLimit: webinar.attendeeLimit,
      passcode: webinar.passcode ?? "",
      panelistEmails: "",
      takeaways: webinar.takeaways.join("\n"),
      questions: webinar.customQuestions,
      agenda: webinar.agenda,
      options: webinar.options,
      controls: webinar.controls,
    };
  }

  const when = defaultWhen();
  return {
    ...when,
    topic: "",
    summary: "",
    description: "",
    track: "",
    durationMin: 60,
    // The browser's zone, falling back to IST — see localTimeZone.
    timeZone: localTimeZone(),
    kind: "live",
    registrationRequired: true,
    approval: "automatic",
    /* 50, not the server's ceiling. See ATTENDEE_LIMITS. Clamped in case an operator has
     * configured a maximum below it — a server sized for 20 must not offer 50. */
    attendeeLimit: maxAttendees > 0 ? Math.min(DEFAULT_ATTENDEE_LIMIT, maxAttendees) : DEFAULT_ATTENDEE_LIMIT,
    passcode: "",
    panelistEmails: "",
    takeaways: "",
    questions: [],
    agenda: [],
    options: {
      practiceSession: true,
      autoRecord: false,
      qAndA: true,
      attendeeChat: true,
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: false,
    },
    // The Zoom-webinar defaults: the audience is private and arrives muted.
    controls: {
      hideAttendees: true,
      muteOnEntry: true,
      allowUnmute: true,
      chatEnabled: true,
      // Everyone by default. A webinar that quietly routed the audience's first
      // messages away from the audience would be a surprise, and the restrictive
      // setting is the one worth a deliberate choice — made in the room, where the
      // host can see who is on the stage to receive them.
      chatDestination: "everyone",
      // Polls and quizzes used to be a checkbox up in Options. It is a session
      // control now: whether to poll the room is decided during the session, next to
      // chat and Q&A, and a host who ticked a box a week earlier still has to be able
      // to change their mind. On by default — the host writes the questions and
      // launches them one at a time, so nothing appears for the audience until they do.
      pollsEnabled: true,
      qaEnabled: true,
      raiseHandEnabled: true,
      reactionsEnabled: true,
      locked: false,
    },
  };
}

export function ScheduleForm({ webinar = null }: { webinar?: Webinar | null }) {
  const router = useRouter();
  const config = useAppConfig();
  const { notify } = useToast();
  const editing = webinar !== null;

  const [form, setForm] = useState<FormState>(() =>
    initialState(webinar, config.maxAttendees),
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"scheduled" | "draft" | null>(null);

  // Built once per mount: the list is ~450 entries and re-sorting it on every
  // keystroke in the topic field is pure waste.
  const zones = useMemo(() => timeZoneNames(), []);
  // The "in your local time" line below is, by definition, the viewer's own zone
  // and locale — neither of which the server shares. Held back until hydration so
  // it never enters the comparison.
  const hydrated = useHydrated();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function toInput(status: "scheduled" | "draft"): WebinarInput | null {
    const startsAt = zonedToInstant(form.date, form.time, form.timeZone);
    if (!startsAt) {
      setFields({ startsAt: "Pick a valid date and time." });
      return null;
    }
    return {
      topic: form.topic,
      summary: form.summary,
      description: form.description,
      track: form.track.trim(),
      startsAt: startsAt.toISOString(),
      durationMin: form.durationMin,
      timeZone: form.timeZone,
      kind: form.kind,
      status,
      registrationRequired: form.registrationRequired,
      approval: form.approval,
      attendeeLimit: form.attendeeLimit,
      passcode: form.passcode.trim(),
      agenda: form.agenda,
      takeaways: form.takeaways
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
      customQuestions: form.questions.filter((q) => q.label.trim() !== ""),
      panelistEmails: form.panelistEmails
        .split(/[\n,;]/)
        .map((e) => e.trim())
        .filter(Boolean),
      options: form.options,
      controls: form.controls,
    };
  }

  async function submit(status: "scheduled" | "draft") {
    setBusy(status);
    setError(null);
    setFields({});

    const input = toInput(status);
    if (!input) {
      setBusy(null);
      return;
    }

    try {
      const saved = editing
        ? await api.updateWebinar(webinar.id, input)
        : await api.createWebinar(input);
      notify(
        editing
          ? "Changes saved."
          : status === "draft"
            ? "Saved as a draft."
            : "Webinar scheduled.",
        "ok",
      );
      router.push(`/host/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFields(err.fields);
        else setError(err.message);
      } else {
        setError("Could not save. Check your connection and try again.");
      }
      setBusy(null);
    }
  }

  const startsAtPreview = useMemo(() => {
    const instant = zonedToInstant(form.date, form.time, form.timeZone);
    if (!instant) return null;
    return instant;
  }, [form.date, form.time, form.timeZone]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit("scheduled");
      }}
      className="grid gap-4"
    >
      {error && <Alert tone="error">{error}</Alert>}

      {/* ---- basics ---- */}
      <Card className="p-5">
        <SectionTitle>Basics</SectionTitle>
        <div className="grid gap-3.5">
          <Text
            label="Topic"
            value={form.topic}
            onChange={(v) => set("topic", v)}
            error={fields.topic}
            placeholder="What is this webinar called?"
            required
            large
          />

          <Text
            label="One-line summary"
            value={form.summary}
            onChange={(v) => set("summary", v)}
            hint="Shown on the browse page, under the title."
          />

          <div>
            <label className="label" htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              className="field"
              rows={4}
              placeholder="Shown on the registration page."
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2">
            {/* Free text with suggestions from what already exists, rather than a
                fixed list nobody can extend without a deploy. */}
            <div>
              <label className="label" htmlFor="track">
                Topic tag
              </label>
              <input
                id="track"
                className="field"
                list="track-suggestions"
                placeholder="e.g. Architecture"
                value={form.track}
                onChange={(e) => set("track", e.target.value)}
              />
              <datalist id="track-suggestions">
                {config.tracks.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>

            <Select
              label="Type"
              value={form.kind}
              onChange={(v) => set("kind", v as FormState["kind"])}
            >
              <option value="live">Live webinar</option>
              <option value="simulive">Simulive (pre-recorded)</option>
              <option value="recurring">Recurring series</option>
            </Select>
          </div>
        </div>
      </Card>

      {/* ---- when ---- */}
      <Card className="p-5">
        <SectionTitle>When</SectionTitle>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="date">
              Date
            </label>
            <input
              id="date"
              type="date"
              className="field"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="time">
              Start time
            </label>
            <input
              id="time"
              type="time"
              className="field"
              value={form.time}
              onChange={(e) => set("time", e.target.value)}
              required
            />
          </div>
          <Select
            label="Duration"
            value={String(form.durationMin)}
            onChange={(v) => set("durationMin", Number(v))}
          >
            {DURATIONS.map((m) => (
              <option key={m} value={m}>
                {m >= 60 ? `${m / 60} hour${m > 60 ? "s" : ""}` : `${m} minutes`}
              </option>
            ))}
          </Select>

          {/* Every IANA zone the browser knows. A four-city list is wrong for most
              of the world and stale the next time a country changes its rules. */}
          <Select
            label="Time zone"
            value={form.timeZone}
            onChange={(v) => set("timeZone", v)}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {timeZoneLabel(z)}
              </option>
            ))}
          </Select>
        </div>

        {fields.startsAt && (
          <p className="mt-2 text-[12px] font-medium text-live">{fields.startsAt}</p>
        )}
        {fields.timeZone && (
          <p className="mt-2 text-[12px] font-medium text-live">{fields.timeZone}</p>
        )}

        {startsAtPreview && hydrated && (
          <p className="mt-3 text-[12px] text-ink-3">
            Starts{" "}
            <strong className="font-medium text-ink-2">
              {startsAtPreview.toLocaleString(undefined, {
                dateStyle: "full",
                timeStyle: "short",
              })}
            </strong>{" "}
            in your local time
            {form.timeZone !== localTimeZone() && ` (${localTimeZone()})`}.
          </p>
        )}
      </Card>

      {/* ---- registration ---- */}
      <Card className="p-5">
        <SectionTitle>Registration</SectionTitle>
        <div className="grid gap-3.5">
          <Toggle
            checked={form.registrationRequired}
            onChange={(v) => set("registrationRequired", v)}
            label="Require registration"
            description="Attendees fill in a form and get a personal join link. Signed-in accounts get it on their account instead."
          />

          <div className="grid gap-3.5 sm:grid-cols-2">
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
              {limitOptions(config.maxAttendees, form.attendeeLimit).map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()} attendees
                </option>
              ))}
            </Select>
          </div>

          <Text
            label="Passcode (optional)"
            value={form.passcode}
            onChange={(v) => set("passcode", v)}
            hint="Shown alongside the webinar ID for anyone dialling in from a calendar invite."
            error={fields.passcode}
          />

          <QuestionEditor
            questions={form.questions}
            onChange={(q) => set("questions", q)}
          />
        </div>
      </Card>

      {/* ---- the stage ---- */}
      <Card className="p-5">
        <SectionTitle>Who is on the stage</SectionTitle>
        <div>
          <label className="label" htmlFor="panelists">
            Panelist emails
          </label>
          <textarea
            id="panelists"
            className="field"
            rows={2}
            placeholder="one@example.com, two@example.com"
            value={form.panelistEmails}
            onChange={(e) => set("panelistEmails", e.target.value)}
          />
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
            Panelists can share their camera and screen. They need an account,
            because a publishing token is minted from a signed-in session — addresses
            without one are skipped.
          </p>
          {fields.panelistEmails && (
            <p className="mt-1 text-[12px] font-medium text-live">
              {fields.panelistEmails}
            </p>
          )}
          {editing && webinar.panelists.length > 0 && (
            <p className="mt-2 text-[12px] text-ink-2">
              Currently on the stage:{" "}
              {webinar.panelists.map((p) => p.name).join(", ")}. Leave the box empty to
              remove them all.
            </p>
          )}
        </div>
      </Card>

      {/* ---- in-session defaults ---- */}
      <Card className="p-5">
        <SectionTitle>How the session starts</SectionTitle>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-2">
          You can change any of these live from the host controls once the webinar
          is running.
        </p>
        <div className="grid gap-1 sm:grid-cols-2">
          <Toggle
            checked={form.controls.hideAttendees}
            onChange={(v) => set("controls", { ...form.controls, hideAttendees: v })}
            label="Hide attendees from each other"
            description="Attendees see only you and the panelists. Enforced by the media server."
          />
          <Toggle
            checked={form.controls.muteOnEntry}
            onChange={(v) => set("controls", { ...form.controls, muteOnEntry: v })}
            label="Mute panelists on entry"
          />
          <Toggle
            checked={form.controls.allowUnmute}
            onChange={(v) => set("controls", { ...form.controls, allowUnmute: v })}
            label="Panelists may unmute themselves"
          />
          <Toggle
            checked={form.controls.chatEnabled}
            onChange={(v) => set("controls", { ...form.controls, chatEnabled: v })}
            label="Attendee chat"
          />
          <Toggle
            checked={form.controls.qaEnabled}
            onChange={(v) => set("controls", { ...form.controls, qaEnabled: v })}
            label="Q&A"
          />
          <Toggle
            checked={form.controls.raiseHandEnabled}
            onChange={(v) => set("controls", { ...form.controls, raiseHandEnabled: v })}
            label="Raise hand"
          />
          <Toggle
            checked={form.controls.reactionsEnabled}
            onChange={(v) => set("controls", { ...form.controls, reactionsEnabled: v })}
            label="Reactions"
          />
        </div>
      </Card>

      {/* ---- the long tail ---- */}
      <Card className="p-5">
        <Disclosure summary="Agenda, takeaways and other options">
          <div className="grid gap-4 pt-1">
            <AgendaEditor agenda={form.agenda} onChange={(a) => set("agenda", a)} />

            <div>
              <label className="label" htmlFor="takeaways">
                What attendees will learn
              </label>
              <textarea
                id="takeaways"
                className="field"
                rows={3}
                placeholder="One per line."
                value={form.takeaways}
                onChange={(e) => set("takeaways", e.target.value)}
              />
            </div>

            <div>
              <span className="label">Other options</span>
              <div className="grid gap-1 sm:grid-cols-2">
                {(
                  [
                    ["practiceSession", "Practice session (backstage)"],
                    ["autoRecord", "Record automatically"],
                    ["captions", "Live captions"],
                    ["multistream", "Stream to YouTube / LinkedIn"],
                    ["postWebinarSurvey", "Post-webinar survey"],
                  ] as const
                ).map(([key, label]) => (
                  <Toggle
                    key={key}
                    checked={form.options[key]}
                    onChange={(v) => set("options", { ...form.options, [key]: v })}
                    label={label}
                  />
                ))}
              </div>
            </div>
          </div>
        </Disclosure>
      </Card>

      <div className="flex flex-wrap items-center gap-2.5 pb-6">
        <Button type="submit" size="lg" disabled={busy !== null}>
          {busy === "scheduled" && <Spinner className="size-4" />}
          {editing ? "Save changes" : "Schedule"}
        </Button>
        {(!editing || webinar.status === "draft") && (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={busy !== null}
            onClick={() => void submit("draft")}
          >
            {busy === "draft" && <Spinner className="size-4" />}
            Save as draft
          </Button>
        )}
        <span className="text-[12px] text-ink-3">
          You can change everything after scheduling.
        </span>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------- fields

function Text({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  required,
  large,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  large?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`field ${large ? "field-lg" : ""} ${error ? "border-live" : ""}`}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="mt-1 text-[12px] font-medium text-live">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11.5px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------- custom questions

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
      <span className="label">Registration questions</span>
      <div className="mb-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">
        Name and email are always asked.
      </div>

      <div className="grid gap-2">
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

// ----------------------------------------------------------------- agenda

function AgendaEditor({
  agenda,
  onChange,
}: {
  agenda: AgendaItem[];
  onChange: (next: AgendaItem[]) => void;
}) {
  function update(index: number, patch: Partial<AgendaItem>) {
    onChange(agenda.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  return (
    <div>
      <span className="label">Agenda</span>
      <div className="grid gap-2">
        {agenda.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <input
              className="field h-9 w-[92px] shrink-0 text-[12.5px]"
              placeholder="0:05"
              value={item.at}
              onChange={(e) => update(i, { at: e.target.value })}
              aria-label={`Agenda item ${i + 1} time`}
            />
            <input
              className="field h-9 flex-1 text-[13px]"
              placeholder="What happens"
              value={item.title}
              onChange={(e) => update(i, { title: e.target.value })}
              aria-label={`Agenda item ${i + 1} title`}
            />
            <button
              type="button"
              onClick={() => onChange(agenda.filter((_, j) => j !== i))}
              aria-label={`Remove agenda item ${i + 1}`}
              className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-live-soft hover:text-live"
            >
              <TrashIcon className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2"
        onClick={() => onChange([...agenda, { at: "", title: "" }])}
      >
        <PlusIcon className="size-3.5" />
        Add an agenda item
      </Button>
    </div>
  );
}
