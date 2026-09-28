import type {
  AgendaItem,
  CustomQuestion,
  SessionControls,
  Webinar,
  WebinarInput,
  WebinarOptions,
} from "@/lib/api-types";
import { instantToZoned, localTimeZone } from "@/lib/format";
import { DEFAULT_REMINDERS } from "../reminder-times";

/* Schedule or edit a webinar.
 *
 * One form for both. PATCH has replace semantics on the server, which means this
 * form is responsible for sending back everything it is not editing — the agenda
 * and takeaways carried in state are exactly that: the editors were removed, and
 * a save must not quietly delete what the page still renders.
 */

export const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

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
export function defaultWhen(): { date: string; time: string } {
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
export function todayInputValue(): string {
  return new Date().toLocaleDateString("en-CA");
}

export type FormState = {
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

export type SetForm = <K extends keyof FormState>(
  key: K,
  value: FormState[K],
) => void;

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
export function limitOptions(maxAttendees: number, current: number): number[] {
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

export function initialState(
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
