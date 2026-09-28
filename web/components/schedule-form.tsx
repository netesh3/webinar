"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Alert, openPickerOnClick, Select, Spinner, Toggle } from "./controls";
import { useAppConfig, useSession, useToast } from "./providers";
import { Button, Card } from "./ui";
import { CalendarIcon, ChevronDownIcon, PlusIcon, TrashIcon } from "./icons";
import { WebinarImagePicker } from "./webinar-image-picker";
import {
  DEFAULT_REMINDERS,
  describeReminders,
  ReminderTimes,
} from "./reminder-times";
import { API_BASE, ApiError, api } from "@/lib/api";
import type {
  AgendaItem,
  CustomQuestion,
  SessionControls,
  Webinar,
  WebinarInput,
  WebinarOptions,
} from "@/lib/api-types";
import type { PreparedWebinarImage } from "@/lib/webinar-image";
import { useHydrated } from "@/lib/clock";
import {
  instantToZoned,
  localTimeZone,
  timeZoneLabel,
  timeZoneNames,
  zonedToInstant,
} from "@/lib/format";
import { WhatsAppRemindersToggle } from "@/engage";
import { useScheduleSurvey } from "./survey/schedule-survey";

/* Schedule or edit a webinar.
 *
 * One form for both. PATCH has replace semantics on the server, which means this
 * form is responsible for sending back everything it is not editing — the agenda
 * carried in state below is exactly that: no editor would have quietly deleted it
 * on every save.
 */

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

/** Default start: today, at the next five-minute mark, in the host's own
 *  zone — a host opening this form usually means to go live soon, not next
 *  week, and having to touch both the date and the time picker on every
 *  single webinar was friction for that common case.
 *
 *  Rounded up, not the exact current minute: the server refuses a start
 *  time already in the past, and "now" stops being now the moment a host
 *  spends even a few seconds on the rest of the form. Five minutes is
 *  enough runway for that without defaulting somebody who really does mean
 *  "right now" oddly far into the future.
 *
 *  Epoch-based rounding rather than manipulating a local Date's fields
 *  directly, so a spring-forward/fall-back transition can't produce an
 *  impossible or duplicated local time — every real-world UTC offset is a
 *  multiple of 5 minutes, so this always lands on a clean local mark too. */
function defaultWhen(): { date: string; time: string } {
  const STEP_MS = 5 * 60_000;
  const rounded = new Date(Math.ceil(Date.now() / STEP_MS) * STEP_MS);
  const hh = String(rounded.getHours()).padStart(2, "0");
  const mm = String(rounded.getMinutes()).padStart(2, "0");
  return { date: rounded.toLocaleDateString("en-CA"), time: `${hh}:${mm}` };
}

/** "2026-09-12" in the BROWSER's own local time, for the date input's `min`.
 *  `toLocaleDateString` with en-CA rather than `toISOString` because the latter
 *  is UTC — past 6pm PT that is already tomorrow, which would let a host in
 *  California pick a date the picker itself calls "today" and still get
 *  refused by the server, which checks the same local "now" the picker is
 *  built from. */
function todayInputValue(): string {
  return new Date().toLocaleDateString("en-CA");
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
  streamKey: string;
  streamWatchUrl: string;
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
  const ceiling =
    maxAttendees > 0
      ? maxAttendees
      : ATTENDEE_LIMITS[ATTENDEE_LIMITS.length - 1];
  const offered = ATTENDEE_LIMITS.filter((n) => n <= ceiling);
  const known: readonly number[] = ATTENDEE_LIMITS;
  const withCurrent =
    current > 0 && !known.includes(current)
      ? [...offered, current]
      : [...offered];
  return [...new Set(withCurrent)].sort((a, b) => a - b);
}

function initialState(
  webinar: Webinar | null,
  maxAttendees: number,
): FormState {
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
      kind: webinar.kind === "recurring" ? "recurring" : "live",
      registrationRequired: webinar.registrationRequired,
      approval: webinar.approval,
      attendeeLimit: webinar.attendeeLimit,
      passcode: webinar.passcode ?? "",
      panelistEmails: "",
      takeaways: webinar.takeaways.join("\n"),
      questions: webinar.customQuestions,
      agenda: webinar.agenda,
      options: {
        ...webinar.options,
        emailReminders: webinar.options.emailReminders !== false,
        reminders: webinar.options.reminders ?? DEFAULT_REMINDERS,
        multistream:
          webinar.options.multistream ||
          Boolean(webinar.streamConfigured) ||
          Boolean(webinar.streamKeySaved),
      },
      controls: webinar.controls,
      streamKey: "",
      streamWatchUrl: webinar.streamWatchUrl ?? "",
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
    attendeeLimit:
      maxAttendees > 0
        ? Math.min(DEFAULT_ATTENDEE_LIMIT, maxAttendees)
        : DEFAULT_ATTENDEE_LIMIT,
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
      emailReminders: true,
      /* Off, unlike email. Every WhatsApp message is charged to the host's own Meta
       * account, so messaging a list on it is something they ask for rather than
       * something they discover on an invoice. */
      whatsappReminders: false,
      reminders: DEFAULT_REMINDERS,
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
      // Follows the "Live captions" option above: the API seeds the control from
      // it on create, so the form does not have to keep the two in step itself.
      captionsEnabled: false,
      locked: false,
    },
    streamKey: "",
    streamWatchUrl: "",
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The wall clock the host picked, as the sticky bar reads it. Built from the
 *  input strings so it does not depend on the viewer's zone. */
function formatScheduleWhen(
  date: string,
  time: string,
  zoneLabel: string,
): string | null {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (![y, m, d, hh, mm].every((n) => Number.isFinite(n))) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 || 12;
  const clock = `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
  const when = `${weekday} ${d} ${MONTHS[m - 1]}, ${clock}`;
  return zoneLabel ? `${when} ${zoneLabel}` : when;
}

function formatDuration(minutes: number): string | null {
  if (!minutes) return null;
  return minutes >= 60
    ? `${minutes / 60} hour${minutes > 60 ? "s" : ""}`
    : `${minutes} minutes`;
}

function shortTimeZone(timeZone: string, at: Date): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

/** One line for the action bar, from the form as it stands. A part that is
 *  still empty is left out; a switch that is off is said, because off is a
 *  choice the host already made. */
function scheduleSummary(
  form: FormState,
  zoneLabel: string,
): { lead: string | null; rest: string } {
  const parts: string[] = [];
  const duration = formatDuration(form.durationMin);
  if (duration) parts.push(duration);
  parts.push(
    form.registrationRequired
      ? form.approval === "manual"
        ? "Registration on, manual approval"
        : "Registration on, auto-approve"
      : "Registration off",
  );
  if (form.attendeeLimit > 0) {
    parts.push(`${form.attendeeLimit.toLocaleString()} seats`);
  }
  const remindersOn =
    form.options.emailReminders || form.options.whatsappReminders;
  if (!remindersOn) {
    parts.push("Reminders off");
  } else if (form.options.reminders.length > 0) {
    parts.push(`Reminders ${describeReminders(form.options.reminders)}`);
  } else {
    parts.push("Reminders on");
  }
  return {
    lead: formatScheduleWhen(form.date, form.time, zoneLabel),
    rest: parts.join(" · "),
  };
}

export function ScheduleForm({ webinar = null }: { webinar?: Webinar | null }) {
  const router = useRouter();
  const config = useAppConfig();
  const { account } = useSession();
  const { notify } = useToast();
  const editing = webinar !== null;

  const [form, setForm] = useState<FormState>(() =>
    initialState(webinar, config.maxAttendees),
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"scheduled" | "draft" | null>(null);

  /* The cover image.
   *
   * Cropped and compressed entirely client-side (see webinar-image-picker.tsx)
   * the moment it is picked, but not uploaded until the webinar itself is saved
   * — a webinar being scheduled for the first time has no slug yet to upload
   * against, and uploading on pick for an EXISTING webinar while leaving the
   * option to cancel the rest of the form would save half an edit. `imageUrl`
   * mirrors what the preview shows: the persisted image to start with, a local
   * object URL once a new one is picked, or null with nothing shown. */
  const [imagePreview, setImagePreview] = useState<string | null>(
    webinar?.imageUrl ? `${API_BASE}${webinar.imageUrl}` : null,
  );
  const [pendingImage, setPendingImage] = useState<PreparedWebinarImage | null>(
    null,
  );
  // True once the host removes a PERSISTED image with no replacement chosen —
  // the thing submit() actually has to tell the server about. Picking a new
  // image after removing one clears this; the upload itself is the replacement.
  const [imageRemoved, setImageRemoved] = useState(false);

  // Built once per mount: the list is ~450 entries and re-sorting it on every
  // keystroke in the topic field is pure waste.
  const zones = useMemo(() => timeZoneNames(), []);
  // The "in your local time" line below is, by definition, the viewer's own zone
  // and locale — neither of which the server shares. Held back until hydration so
  // it never enters the comparison.
  const hydrated = useHydrated();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const survey = useScheduleSurvey(webinar, form.durationMin);

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
      // Mirrors whether a survey is set up, for the places that only read the webinar.
      options: { ...form.options, postWebinarSurvey: survey.on },
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
    const surveyProblem = survey.problem();
    if (surveyProblem) {
      setError(surveyProblem);
      document
        .getElementById("survey")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setBusy(null);
      return;
    }

    try {
      let saved = editing
        ? await api.updateWebinar(webinar.id, input)
        : await api.createWebinar(input);

      /* The image, once the webinar itself has a slug to attach it to.
       *
       * Best-effort and after the fact, deliberately: the webinar is already
       * saved by this point, and failing the whole save over a cover image —
       * the one field on this form that is purely decorative — would be the
       * wrong trade. A failure here is a toast, not a blocked navigation. */
      if (pendingImage) {
        try {
          saved = await api.uploadWebinarImage(
            saved.id,
            pendingImage.blob,
            pendingImage.mime,
          );
        } catch {
          notify(
            "Saved, but the cover image didn't upload. Edit the webinar to try again.",
            "info",
          );
        }
      } else if (imageRemoved) {
        try {
          saved = await api.deleteWebinarImage(saved.id);
        } catch {
          notify(
            "Saved, but the cover image couldn't be removed. Edit the webinar to try again.",
            "info",
          );
        }
      }

      try {
        if (form.options.multistream) {
          if (form.streamKey || form.streamWatchUrl) {
            saved = await api.setWebinarStream(saved.id, {
              streamKey: form.streamKey,
              watchUrl: form.streamWatchUrl,
            });
          }
          // Connected YouTube with no pasted key: the live is created when
          // the webinar starts, so we do not mint a Studio event on every save.
        } else if (
          saved.streamConfigured ||
          saved.streamKeySaved ||
          saved.streamWatchUrl
        ) {
          saved = await api.setWebinarStream(saved.id, {
            off: true,
            dropWatch: true,
            streamKey: "",
            watchUrl: "",
          });
        }
      } catch (err) {
        notify(
          err instanceof Error
            ? `Saved the webinar, but YouTube streaming wasn't set: ${err.message}`
            : "Saved the webinar, but YouTube streaming wasn't set.",
          "info",
        );
      }

      const surveyWarning = await survey.persist(saved.id);
      if (surveyWarning) notify(surveyWarning, "info");

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

  const summaryZone =
    hydrated && startsAtPreview && form.timeZone
      ? shortTimeZone(form.timeZone, startsAtPreview)
      : "";
  const summary = scheduleSummary(form, summaryZone);
  const showDraft = !editing || webinar.status === "draft";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit("scheduled");
      }}
    >
      {/* The bar is position:fixed, so it does not take a row. This padding
          is what keeps the last fields from sitting underneath it. */}
      <div className="grid gap-5 pb-48 lg:pb-24">
        <p className="text-[13px] text-ink-2">
          A name, a time and a picture — you&apos;re done. You can change
          anything later.
        </p>

        {error && <Alert tone="error">{error}</Alert>}

        <FormGroup label="The webinar">
          <FormSection
            title="Basics"
            description="What people see on the browse and registration pages."
            first
          >
            <div className="grid gap-3.5">
              {/* Topic and summary, then the cover, then the description, so a
                  narrow screen reads in that order. `contents` lets those
                  fields join this grid below `lg`; from `lg` they stack in the
                  left column and the description takes the leftover height. */}
              <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-stretch lg:gap-x-5">
                <div className="contents lg:flex lg:h-full lg:flex-col lg:gap-3.5">
                  <div className="order-1 lg:order-none">
                    <Text
                      label="Topic"
                      value={form.topic}
                      onChange={(v) => set("topic", v)}
                      error={fields.topic}
                      placeholder="What is this webinar called?"
                      required
                      large
                    />
                  </div>

                  <div className="order-2 lg:order-none">
                    <Text
                      label="One-line summary"
                      value={form.summary}
                      onChange={(v) => set("summary", v)}
                      hint="Shown on the browse page, under the title."
                    />
                  </div>
                </div>

                <div className="order-3 lg:order-none lg:self-start">
                  <WebinarImagePicker
                    previewUrl={imagePreview}
                    onChange={(prepared, preview) => {
                      setPendingImage(prepared);
                      setImageRemoved(false);
                      setImagePreview(preview);
                    }}
                    onRemove={() => {
                      setPendingImage(null);
                      setImagePreview(null);
                      // Only worth telling the server about if there was something
                      // persisted to remove — a pending, never-uploaded selection being
                      // cleared is not a change the webinar has ever seen.
                      setImageRemoved(Boolean(webinar?.imageUrl));
                    }}
                  />
                </div>
              </div>
            </div>
          </FormSection>

          <FormSection
            title="When"
            description="Defaults to today, at the next five-minute mark."
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.5fr)]">
              <div>
                <label className="label" htmlFor="date">
                  Date
                </label>
                <input
                  id="date"
                  type="date"
                  onClick={openPickerOnClick}
                  className="field"
                  value={form.date}
                  onChange={(e) => set("date", e.target.value)}
                  // Only on a NEW webinar — an existing one may legitimately show a
                  // past date (it already ran, or it's a draft nobody finished), and
                  // an edit that touches an unrelated field must not be blocked by a
                  // date the host never touched. The server enforces the real rule
                  // (see normalizeWebinarInput's isCreate); this is a nudge so the
                  // native picker does not even offer a date that will be refused.
                  min={editing ? undefined : todayInputValue()}
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
                  onClick={openPickerOnClick}
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
                    {m >= 60
                      ? `${m / 60} hour${m > 60 ? "s" : ""}`
                      : `${m} minutes`}
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
              <p className="mt-2 text-[12px] font-medium text-live">
                {fields.startsAt}
              </p>
            )}
            {fields.timeZone && (
              <p className="mt-2 text-[12px] font-medium text-live">
                {fields.timeZone}
              </p>
            )}

            {startsAtPreview && hydrated && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] text-ink-3">
                <CalendarIcon className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
                <span>
                  Starts{" "}
                  <strong className="font-medium text-ink-2">
                    {startsAtPreview.toLocaleString(undefined, {
                      dateStyle: "full",
                      timeStyle: "short",
                    })}
                  </strong>{" "}
                  in your local time
                  {form.timeZone !== localTimeZone() && ` (${localTimeZone()})`}
                  .
                </span>
              </p>
            )}
          </FormSection>
        </FormGroup>

        <MoreOptions
          editing={editing}
          summary={defaultsSummary(form, survey.on)}
        >
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
                    onChange={(v) =>
                      set("approval", v as FormState["approval"])
                    }
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

                <QuestionEditor
                  questions={form.questions}
                  onChange={(q) => set("questions", q)}
                />
              </div>
            </FormSection>
          </FormGroup>
          <FormGroup label="Reminders">
            {/* Email, WhatsApp and the times they share. They used to sit in
              Other options, which hid the switches from the times they control. */}
            <FormSection
              title="Reminders"
              first
              description="The same times drive email and WhatsApp."
            >
              <div className="grid gap-3.5">
                <div className="grid gap-2.5 lg:grid-cols-2">
                  <Boxed
                    on={Boolean(form.options.emailReminders)}
                    className="lg:only:col-span-2"
                  >
                    <Toggle
                      checked={Boolean(form.options.emailReminders)}
                      onChange={(v) =>
                        set("options", { ...form.options, emailReminders: v })
                      }
                      label="Email reminders"
                    />
                  </Boxed>
                  <WhatsAppRemindersToggle
                    boxed
                    checked={Boolean(form.options.whatsappReminders)}
                    onChange={(v) =>
                      set("options", { ...form.options, whatsappReminders: v })
                    }
                  />
                </div>
                <ReminderTimes
                  value={form.options.reminders}
                  onChange={(r) =>
                    set("options", { ...form.options, reminders: r })
                  }
                  disabled={
                    !form.options.emailReminders &&
                    !form.options.whatsappReminders
                  }
                />
              </div>
            </FormSection>
          </FormGroup>
          <FormGroup label="In the room">
            <FormSection
              title="How the session starts"
              description="You can change any of these live from the host controls once the webinar is running."
              first
            >
              <div className="grid gap-1 lg:grid-cols-2">
                <Toggle
                  checked={form.controls.hideAttendees}
                  onChange={(v) =>
                    set("controls", { ...form.controls, hideAttendees: v })
                  }
                  label="Hide attendees from each other"
                  description="Attendees see only you and the panelists. Enforced by the media server."
                />
                <Toggle
                  checked={form.controls.muteOnEntry}
                  onChange={(v) =>
                    set("controls", { ...form.controls, muteOnEntry: v })
                  }
                  label="Mute panelists on entry"
                />
                <Toggle
                  checked={form.controls.allowUnmute}
                  onChange={(v) =>
                    set("controls", { ...form.controls, allowUnmute: v })
                  }
                  label="Panelists may unmute themselves"
                />
                <Toggle
                  checked={form.controls.chatEnabled}
                  onChange={(v) =>
                    set("controls", { ...form.controls, chatEnabled: v })
                  }
                  label="Attendee chat"
                />
                <Toggle
                  checked={form.controls.qaEnabled}
                  onChange={(v) =>
                    set("controls", { ...form.controls, qaEnabled: v })
                  }
                  label="Q&A"
                />
                <Toggle
                  checked={form.controls.raiseHandEnabled}
                  onChange={(v) =>
                    set("controls", { ...form.controls, raiseHandEnabled: v })
                  }
                  label="Raise hand"
                />
                <Toggle
                  checked={form.controls.reactionsEnabled}
                  onChange={(v) =>
                    set("controls", { ...form.controls, reactionsEnabled: v })
                  }
                  label="Reactions"
                />
              </div>
            </FormSection>

            <FormSection
              title="Who is on the stage"
              description="Panelists can share their camera and screen."
            >
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
                  They need an account, because a publishing token is minted
                  from a signed-in session — addresses without one are skipped.
                </p>
                {fields.panelistEmails && (
                  <p className="mt-1 text-[12px] font-medium text-live">
                    {fields.panelistEmails}
                  </p>
                )}
                {editing && webinar.panelists.length > 0 && (
                  <p className="mt-2 text-[12px] text-ink-2">
                    Currently on the stage:{" "}
                    {webinar.panelists.map((p) => p.name).join(", ")}. Leave the
                    box empty to remove them all.
                  </p>
                )}
              </div>
            </FormSection>

            <FormSection
              title="Recording and extras"
              description="Recording, captions and streaming."
            >
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-7">
                <div className="grid content-start gap-4">
                  <AgendaEditor
                    agenda={form.agenda}
                    onChange={(a) => set("agenda", a)}
                  />

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
                </div>

                <div>
                  <span className="label">Other options</span>
                  <div className="rounded-[10px] border border-line px-2 py-1">
                    {(
                      [
                        ["autoRecord", "Record automatically"],
                        ["captions", "Live captions"],
                        ["multistream", "Stream to YouTube / LinkedIn"],
                      ] as const
                    ).map(([key, label]) => (
                      <Toggle
                        key={key}
                        checked={Boolean(form.options[key])}
                        onChange={(v) =>
                          set("options", { ...form.options, [key]: v })
                        }
                        label={label}
                      />
                    ))}
                  </div>
                  {form.options.multistream && (
                    <div className="mt-3 grid gap-2">
                      {config.youtubeOAuth && account?.youtube?.connected ? (
                        <p className="text-[12.5px] text-ink-2">
                          Linked channel:{" "}
                          <span className="font-medium text-ink">
                            {account.youtube.channelTitle || "YouTube"}
                          </span>
                          . We create an Unlisted live when you start, and put
                          the watch link in Recordings. Paste a Studio key below
                          only if you want a different destination.
                        </p>
                      ) : config.youtubeOAuth ? (
                        <p className="text-[12.5px] text-ink-2">
                          <a
                            href={api.youtubeConnectURL(
                              typeof window === "undefined"
                                ? "/host/schedule"
                                : window.location.pathname,
                            )}
                            className="font-medium text-brand hover:underline"
                          >
                            Connect YouTube
                          </a>{" "}
                          to create the live automatically, or paste a stream
                          key from Studio.
                        </p>
                      ) : null}
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="grid gap-1">
                          <span className="text-[12.5px] font-medium text-ink">
                            YouTube watch link
                          </span>
                          <input
                            type="url"
                            value={form.streamWatchUrl}
                            onChange={(e) =>
                              set("streamWatchUrl", e.target.value)
                            }
                            placeholder="https://youtu.be/…"
                            className="h-10 rounded-lg border border-line bg-surface px-3 text-[13px]"
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className="text-[12.5px] font-medium text-ink">
                            Stream key
                          </span>
                          <input
                            type="password"
                            autoComplete="off"
                            value={form.streamKey}
                            onChange={(e) => set("streamKey", e.target.value)}
                            placeholder={
                              webinar?.streamKeySaved
                                ? "Already saved — paste a new key to replace"
                                : "From YouTube Studio → Go live"
                            }
                            className="h-10 rounded-lg border border-line bg-surface px-3 font-mono text-[13px]"
                          />
                        </label>
                      </div>
                      <p className="text-[12px] text-ink-3">
                        We push the same mix attendees see. Set the YouTube live
                        to Unlisted or Private if you want it as a recording.
                        The watch link shows in the recordings tab after the
                        session.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </FormSection>
          </FormGroup>
          <FormGroup label="Page and feedback">
            <FormSection
              title="About the webinar"
              description="The full description and the topic tag, on the registration page."
              first
            >
              <div className="grid gap-3.5">
                <div className="order-4 flex min-h-28 flex-col lg:order-none lg:min-h-0 lg:flex-1">
                  <label className="label" htmlFor="description">
                    Description
                  </label>
                  <div className="min-h-28 lg:relative lg:min-h-0 lg:flex-1">
                    <textarea
                      id="description"
                      className="field lg:absolute lg:inset-0 lg:!resize-none"
                      rows={4}
                      placeholder="Shown on the registration page."
                      value={form.description}
                      onChange={(e) => set("description", e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-5">
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

                  <KindControl
                    value={form.kind}
                    onChange={(v) => set("kind", v)}
                  />
                </div>
              </div>
            </FormSection>
            <FormSection
              title="Feedback survey"
              description="Set it up now; in the room it's one button. Results land on the webinar's page afterwards."
            >
              {survey.node}
            </FormSection>
          </FormGroup>
        </MoreOptions>
      </div>

      <ActionBar
        lead={summary.lead}
        rest={summary.rest}
        editing={editing}
        showDraft={showDraft}
        busy={busy}
        onDraft={() => void submit("draft")}
      />
    </form>
  );
}

/* What the webinar will do without anyone opening "Change", as short phrases: a new host
 * reads their webinar's setup at a glance, and nothing is hidden behind the fold. */
function defaultsSummary(
  form: FormState,
  surveyOn: boolean,
): { bold: string; rest: string }[] {
  const o = form.options;
  const channels = [
    o.emailReminders && "email",
    o.whatsappReminders && "WhatsApp",
  ]
    .filter(Boolean)
    .join(" & ");
  const times = describeReminders(o.reminders ?? DEFAULT_REMINDERS);
  const room = [
    form.controls.chatEnabled && "Chat",
    form.controls.qaEnabled && "Q&A",
  ]
    .filter(Boolean)
    .join(" & ");
  return [
    {
      bold: !form.registrationRequired
        ? "Open link"
        : form.approval === "manual"
          ? "You approve each one"
          : "Anyone can register",
      rest: form.registrationRequired
        ? `up to ${form.attendeeLimit.toLocaleString()}`
        : "no form",
    },
    { bold: "Reminders", rest: channels ? `${times} · ${channels}` : "off" },
    ...(room ? [{ bold: room, rest: "on" }] : []),
    {
      bold: o.autoRecord ? "Recorded" : "Not recorded",
      rest: o.autoRecord ? "replay sent after" : "",
    },
    { bold: "Feedback", rest: surveyOn ? "asked at the end" : "off" },
  ];
}

/* Everything but the basics, folded: the defaults as chips, and "Change" to open the four
 * groups. Open from the start when editing — a host who pressed Edit came to change one of
 * these. */
function MoreOptions({
  editing,
  summary,
  children,
}: {
  editing: boolean;
  summary: { bold: string; rest: string }[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(editing);
  return (
    <div className="grid gap-5">
      <Card className="px-4 py-3.5 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-ink">
              {editing ? "Everything else" : "Already set up for you"}
            </h2>
            <p className="text-[12px] text-ink-3">
              {editing
                ? "Registration, reminders, the room, the page and feedback."
                : "Sensible defaults — change any of them."}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? "Hide" : "Change"}
            <ChevronDownIcon
              className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {summary.map((c) => (
            <span
              key={c.bold}
              className="rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2"
            >
              <b className="font-medium text-ink">{c.bold}</b>
              {c.rest ? ` · ${c.rest}` : ""}
            </span>
          ))}
        </div>
      </Card>
      {/* Kept mounted when folded, so the survey builder and every field keep their state
          and the form still submits them. */}
      <div className={open ? "grid gap-5" : "hidden"}>{children}</div>
    </div>
  );
}

function FormGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold tracking-[0.07em] text-ink-3 uppercase">
        {label}
      </h2>
      <Card>{children}</Card>
    </div>
  );
}

function FormSection({
  title,
  description,
  first,
  children,
}: {
  title: string;
  description: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`grid gap-3 px-4 py-5 lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start lg:gap-8 lg:px-6 lg:py-6 ${
        first ? "" : "border-t border-line"
      }`}
    >
      <div>
        <h3 className="text-[14px] font-semibold tracking-[-0.005em] text-ink">
          {title}
        </h3>
        <p className="mt-1 text-[12px] leading-normal text-ink-3">
          {description}
        </p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Boxed({
  on,
  className = "",
  children,
}: {
  on: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-[10px] border px-1.5 py-0.5 ${
        on ? "border-brand-line bg-brand-soft" : "border-line bg-surface"
      } ${className}`}
    >
      {children}
    </div>
  );
}

function KindControl({
  value,
  onChange,
}: {
  value: FormState["kind"];
  onChange: (next: FormState["kind"]) => void;
}) {
  const name = useId();
  const labelId = useId();
  const options = [
    ["live", "Live webinar"],
    ["recurring", "Recurring series"],
  ] as const;
  return (
    <div>
      <span className="label" id={labelId}>
        Type
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex h-10 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
      >
        {options.map(([option, label]) => {
          const active = value === option;
          return (
            <label
              key={option}
              className={`flex flex-1 cursor-pointer items-center justify-center rounded-md text-[13px] font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40 ${
                active
                  ? "border border-line bg-surface text-ink"
                  : "border border-transparent text-ink-2"
              }`}
            >
              <input
                type="radio"
                name={name}
                value={option}
                checked={active}
                onChange={() => onChange(option)}
                className="sr-only"
              />
              {label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ActionBar({
  lead,
  rest,
  editing,
  showDraft,
  busy,
  onDraft,
}: {
  lead: string | null;
  rest: string;
  editing: boolean;
  showDraft: boolean;
  busy: "scheduled" | "draft" | null;
  onDraft: () => void;
}) {
  return (
    <div
      data-schedule-bar
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2.5 px-4 py-2.5 sm:px-5 lg:flex-row lg:items-center lg:gap-4 lg:py-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-[12.5px] leading-snug text-ink-2 lg:items-center">
          <span
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ok lg:mt-0"
            aria-hidden
          />
          <span className="min-w-0 lg:truncate">
            {lead && <strong className="font-semibold text-ink">{lead}</strong>}
            {rest && (
              <span>
                {lead ? " · " : ""}
                {rest}
              </span>
            )}
          </span>
        </p>
        <div className="flex gap-2 lg:shrink-0">
          {showDraft && (
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="flex-1 lg:flex-none"
              disabled={busy !== null}
              onClick={onDraft}
            >
              {busy === "draft" && <Spinner className="size-4" />}
              Save as draft
            </Button>
          )}
          <Button
            type="submit"
            size="lg"
            className="flex-1 lg:flex-none"
            disabled={busy !== null}
          >
            {busy === "scheduled" && <Spinner className="size-4" />}
            {editing ? "Save changes" : "Schedule"}
          </Button>
        </div>
      </div>
    </div>
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
