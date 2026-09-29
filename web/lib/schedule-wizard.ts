/* The create/edit webinar form's two steps, the `?step=` values older links
 * used, and what must be right on step 1 before the host moves on or schedules.
 *
 * React-free so node can test it directly (lib/schedule-wizard.test.mts). The
 * server stays the authority on every rule — these only let the host hear
 * about a problem on the field that owns it, before a round trip. */

export type Step = "webinar" | "messages";

export const STEPS: readonly { id: Step; title: string }[] = [
  { id: "webinar", title: "The webinar" },
  { id: "messages", title: "Messages & follow-ups" },
];

/* Steps the form used to have. The four-step form had details, survey (now a
 * section of The webinar), followups and review (gone: Schedule sits in the
 * footer of both steps). */
const LEGACY: Record<string, Step> = {
  details: "webinar",
  survey: "webinar",
  review: "webinar",
  schedule: "webinar",
  followups: "messages",
  "follow-ups": "messages",
};

/** `?step=` to a step. Anything unknown opens The webinar. */
export function stepFrom(value: string | null): Step {
  if (value == null) return "webinar";
  if (Object.hasOwn(LEGACY, value)) return LEGACY[value];
  return STEPS.some((s) => s.id === value) ? (value as Step) : "webinar";
}

/** The section an old `?step=` pointed at, when it is now part of a step. */
export function legacyAnchor(value: string | null): string | null {
  return value === "survey" ? "survey" : null;
}

export function stepIndex(step: Step): number {
  return STEPS.findIndex((s) => s.id === step);
}

export function nextStep(step: Step): Step | null {
  return STEPS[stepIndex(step) + 1]?.id ?? null;
}

export function prevStep(step: Step): Step | null {
  const i = stepIndex(step);
  return i > 0 ? STEPS[i - 1].id : null;
}

export type Issue = {
  id: string;
  step: Step;
  message: string;
  /** Element id to scroll to and, when it is (or holds) a field, focus. */
  target: string;
  /** The `fields` key the inline error shows under, when there is one. */
  field?: string;
};

export type IssueInput = {
  topic: string;
  startsAt: Date | null;
  /** Only a NEW webinar is refused for starting in the past (see the API's isCreate). */
  editing: boolean;
  /** Null until the clock is known on the client; the past check waits for it. */
  now: number | null;
  /** The first registration question whose choices are not usable, or null. */
  questionProblem: string | null;
  watchUrl: string;
  multistream: boolean;
  /** From the feedback survey's own validation, or null. */
  surveyProblem: string | null;
};

export function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Every problem that stops Next or Schedule, in the order step 1 shows them. */
export function scheduleIssues(i: IssueInput): Issue[] {
  const out: Issue[] = [];
  if (i.topic.trim() === "") {
    out.push({
      id: "topic",
      step: "webinar",
      message: "Add a topic — it's the title people see on the invite.",
      target: "topic",
      field: "topic",
    });
  }
  if (!i.startsAt) {
    out.push({
      id: "when",
      step: "webinar",
      message: "Pick a valid date and time.",
      target: "date",
      field: "startsAt",
    });
  } else if (!i.editing && i.now != null && i.startsAt.getTime() < i.now) {
    out.push({
      id: "when-past",
      step: "webinar",
      message: "Pick a date and time that hasn't already passed.",
      target: "date",
      field: "startsAt",
    });
  }
  if (i.questionProblem) {
    out.push({
      id: "questions",
      step: "webinar",
      message: `A registration question needs a fix: ${i.questionProblem}`,
      target: "settings-registration",
      field: "customQuestions",
    });
  }
  if (i.multistream && i.watchUrl.trim() !== "" && !isAbsoluteUrl(i.watchUrl.trim())) {
    out.push({
      id: "watch-url",
      step: "webinar",
      message: "The YouTube watch link should be a full link, starting with https://.",
      target: "watch-url",
    });
  }
  if (i.surveyProblem) {
    out.push({
      id: "survey",
      step: "webinar",
      message: i.surveyProblem,
      target: "survey",
    });
  }
  return out;
}

/** The issues that belong to `step` — what its Next button checks. */
export function issuesFor(issues: Issue[], step: Step): Issue[] {
  return issues.filter((i) => i.step === step);
}
