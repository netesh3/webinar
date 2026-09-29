/* Post-event survey: the pure half of the attendee card and the host builder.
 *
 * React-free so node can test it directly (lib/survey.test.mts). The server is the authority
 * on every rule here — internal/survey in the API — and these mirror it only so the host and
 * the attendee are told before a round trip, not instead of one. */

import type {
  AudienceSurvey,
  Survey,
  SurveyAnswerInput,
  SurveyInput,
  SurveyQuestion,
  SurveyQuestionInput,
  SurveyQuestionKind,
} from "./api-types.ts";

// Mirrors api/types/survey.go. Literal here rather than imported so node can run this file
// without resolving the generated module's value exports through the app's path aliases.
export const LIMITS = {
  questions: 5,
  options: 6,
  prompt: 200,
  option: 80,
  title: 120,
  button: 40,
  url: 2048,
  text: 1000,
  sendAfterMin: 600,
} as const;

export const DEFAULT_TITLE = "How was the session?";
export const DEFAULT_BUTTON = "Open survey";

/** 1..5 → the word under the star, for sighted users and screen readers alike. */
export const STAR_LABELS = ["Poor", "Fair", "Good", "Very good", "Excellent"] as const;

export function starLabel(rating: number): string {
  return STAR_LABELS[rating - 1] ?? "";
}

export const KIND_LABELS: Record<string, string> = {
  rating_5: "1–5 stars",
  nps_10: "0–10 recommend",
  single_choice: "Multiple choice",
  text: "Short answer",
};

/** Question templates the builder offers, in order. */
export const QUESTION_TEMPLATES: readonly SurveyQuestionInput[] = [
  { kind: "nps_10", prompt: "How likely are you to recommend this session to a friend or colleague?", required: false },
  { kind: "text", prompt: "What was the most useful part?", required: false },
  { kind: "text", prompt: "What could be improved?", required: false },
  { kind: "single_choice", prompt: "How was the pace?", required: false, options: ["Too slow", "Just right", "Too fast"] },
  { kind: "rating_5", prompt: "How relevant was the content to you?", required: false },
];

export function blankQuestion(kind: SurveyQuestionKind): SurveyQuestionInput {
  const template = QUESTION_TEMPLATES.find((t) => t.kind === kind);
  return {
    kind,
    prompt: template?.prompt ?? "",
    required: false,
    options: kind === "single_choice" ? [...(template?.options ?? ["", ""])] : [],
  };
}

// ---------------------------------------------------------------- the builder

export function emptyInput(): SurveyInput {
  return {
    mode: "builtin",
    title: "",
    buttonLabel: "",
    externalUrl: "",
    askRating: true,
    sendAt: "manual",
    sendAfterMin: 0,
    questions: [blankQuestion("nps_10"), blankQuestion("text")],
  };
}

/* The three ways a survey reaches the room, in the order the builder offers them. The first
 * is the recommendation: the host puts it on screen while everyone is still there, waits for
 * the answers, and only then ends. Timing is not a lock-in — any of them can be sent early
 * from the room. */
export const SEND_CHOICES = [
  {
    id: "manual",
    title: "I'll put it on screen",
    body: "You press Send survey in the room, usually just before you wrap up. It pops up in the middle of everyone's screen, and you end once they've answered.",
    recommended: true,
  },
  {
    id: "at_minute",
    title: "At a set time",
    body: "Pops up on its own at the minute you pick. If you finish before then, it goes out as you end.",
    recommended: false,
  },
  {
    id: "on_end",
    title: "When I end the webinar",
    body: "Pops up for everyone the moment you press End. Quickest for you, but some people will already have closed the tab.",
    recommended: false,
  },
] as const;

/** A suggested minute for "at a set time": ten minutes before the scheduled end. */
export function suggestedSendMinute(durationMin: number): number {
  return Math.max(1, Math.min(LIMITS.sendAfterMin, durationMin - 10));
}

/** "Pops up 50 min in", "Goes out when you end", "You put it on screen". */
export function sendSummary(s: Pick<SurveyInput, "sendAt" | "sendAfterMin">): string {
  if (s.sendAt === "at_minute") return `Pops up ${s.sendAfterMin ?? 0} min in`;
  if (s.sendAt === "on_end") return "Pops up when you end";
  return "You put it on screen";
}

/** The saved survey as the builder edits it: the input the PUT takes, ids kept. */
export function toInput(s: Survey): SurveyInput {
  return {
    mode: s.mode,
    title: s.title,
    buttonLabel: s.buttonLabel,
    externalUrl: s.externalUrl,
    askRating: s.askRating,
    sendAt: s.sendAt,
    sendAfterMin: s.sendAfterMin,
    questions: s.questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      required: q.required,
      options: q.kind === "single_choice" ? [...q.options] : [],
    })),
  };
}

const collapse = (s: string) => s.trim().split(/\s+/).filter(Boolean).join(" ");
const chars = (s: string) => [...s].length;

/** A plain https URL check matching the server's, for the builder's inline message. */
export function urlProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Paste the link to your survey.";
  if (v.length > LIMITS.url) return "That link is too long.";
  if (/\s/.test(v)) return "That link has spaces in it.";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "That doesn't look like a web link.";
  }
  if (u.protocol !== "https:") return "Use an https:// link.";
  if (u.username || u.password) return "Links with a username or password aren't allowed.";
  if (!u.hostname.includes(".")) return "That link has no website in it.";
  return null;
}

/** Field → message for everything the server would refuse. Empty when it will save. */
export function validateInput(i: SurveyInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (chars(collapse(i.title)) > LIMITS.title) out.title = `Keep the title under ${LIMITS.title} characters.`;
  if (chars(collapse(i.buttonLabel)) > LIMITS.button) out.buttonLabel = `Keep the button label under ${LIMITS.button} characters.`;
  if (i.sendAt === "at_minute") {
    const m = i.sendAfterMin ?? 0;
    if (!Number.isInteger(m) || m < 1 || m > LIMITS.sendAfterMin) {
      out.sendAfterMin = `Pick a minute between 1 and ${LIMITS.sendAfterMin}.`;
    }
  }
  if (i.mode === "link") {
    const p = urlProblem(i.externalUrl);
    if (p) out.externalUrl = p;
    return out;
  }
  if (i.questions.length > LIMITS.questions) out.questions = `At most ${LIMITS.questions} extra questions.`;
  i.questions.forEach((q, n) => {
    const key = `questions.${n}`;
    const prompt = collapse(q.prompt);
    if (!prompt) out[key] = "Add the question text.";
    else if (chars(prompt) > LIMITS.prompt) out[key] = `Keep it under ${LIMITS.prompt} characters.`;
    else if (q.kind === "single_choice") {
      const opts = (q.options ?? []).map(collapse).filter(Boolean);
      if (opts.length < 2) out[key] = "Add at least two options.";
      else if (opts.length > LIMITS.options) out[key] = `At most ${LIMITS.options} options.`;
      else if (opts.some((o) => chars(o) > LIMITS.option)) out[key] = `Keep options under ${LIMITS.option} characters.`;
    }
  });
  return out;
}

/** What would be sent: trimmed, link mode without questions, options only on choices. */
export function cleanInput(i: SurveyInput): SurveyInput {
  const link = i.mode === "link";
  return {
    ...i,
    title: collapse(i.title),
    buttonLabel: collapse(i.buttonLabel),
    externalUrl: link ? i.externalUrl.trim() : "",
    askRating: link ? i.askRating : true,
    sendAfterMin: i.sendAt === "at_minute" ? (i.sendAfterMin ?? 0) : 0,
    questions: link
      ? []
      : i.questions.map((q) => ({
          ...q,
          prompt: collapse(q.prompt),
          options: q.kind === "single_choice" ? (q.options ?? []).map(collapse).filter(Boolean) : [],
        })),
  };
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** A preview Survey from the builder's input, for the host's "what attendees see" pane. */
export function previewSurvey(i: SurveyInput): Survey {
  const c = cleanInput(i);
  return {
    id: "preview",
    mode: c.mode,
    title: c.title,
    buttonLabel: c.buttonLabel,
    externalUrl: c.externalUrl,
    askRating: c.askRating,
    status: "live",
    sendAt: c.sendAt,
    sendAfterMin: c.sendAfterMin ?? 0,
    questions: c.questions.map((q, n) => ({
      id: q.id || `preview-${n}`,
      kind: q.kind,
      prompt: q.prompt || "Untitled question",
      required: q.required,
      options: q.options ?? [],
    })),
    updatedAt: "",
    responses: 0,
    linkClicks: 0,
    locked: false,
  };
}

// ---------------------------------------------------------------- the attendee

export interface Draft {
  rating: number | null;
  answers: Record<string, number | string | undefined>;
}

export const emptyDraft = (): Draft => ({ rating: null, answers: {} });

export function asksRating(s: Survey): boolean {
  return s.mode === "builtin" || s.askRating;
}

/** Why Submit is disabled, or null when it may be pressed. */
export function draftProblem(s: Survey, d: Draft): string | null {
  if (asksRating(s) && !d.rating) return "Pick a star rating.";
  if (s.mode === "link") return null;
  for (const q of s.questions) {
    if (!q.required) continue;
    const v = d.answers[q.id];
    if (v === undefined || (typeof v === "string" && !v.trim())) return `Answer “${q.prompt}”.`;
  }
  for (const q of s.questions) {
    const v = d.answers[q.id];
    if (q.kind === "text" && typeof v === "string" && chars(v.trim()) > LIMITS.text) {
      return `Keep your answer under ${LIMITS.text} characters.`;
    }
  }
  return null;
}

/** The request body for a draft. Blank text answers and unanswered questions are left out. */
export function toAnswers(s: Survey, d: Draft): SurveyAnswerInput[] {
  if (s.mode === "link") return [];
  const out: SurveyAnswerInput[] = [];
  for (const q of s.questions) {
    const v = d.answers[q.id];
    if (q.kind === "text") {
      if (typeof v === "string" && v.trim()) out.push({ questionId: q.id, text: v.trim() });
    } else if (typeof v === "number") {
      out.push({ questionId: q.id, number: v });
    }
  }
  return out;
}

export function scaleFor(q: SurveyQuestion): number[] {
  if (q.kind === "rating_5") return [1, 2, 3, 4, 5];
  if (q.kind === "nps_10") return Array.from({ length: 11 }, (_, i) => i);
  if (q.kind === "single_choice") return q.options.map((_, i) => i);
  return [];
}

/* When the room should put the survey in front of somebody.
 *
 *   popup      live, not yet answered, not dismissed for this revision: the centred card.
 *   leave      armed for the end (or live) and not answered: offered as they leave early.
 *   none       nothing to ask.
 *
 * "Answered" means submitted; a link survey whose rating is not asked also counts as done
 * once its link was opened, since there is nothing else to collect here. */
export function isDone(a: AudienceSurvey): boolean {
  if (!a.survey) return true;
  if (a.mine.submitted) return true;
  return a.survey.mode === "link" && !a.survey.askRating && a.mine.linkClicked;
}

export function surveyMoment(a: AudienceSurvey | null, dismissed: boolean): "popup" | "leave" | "none" {
  if (!a || !a.survey || isDone(a)) return "none";
  if (a.live && !dismissed) return "popup";
  return "leave";
}

/** A dismissal is remembered per survey and per launch, so a relaunch (a second ask) returns. */
export function dismissalKey(s: Survey | undefined): string | null {
  return s ? `${s.id}:${s.launchedAt ?? ""}` : null;
}

// ---------------------------------------------------------------- results

/** Width percentages for a distribution, largest bar = 100, all-zero = all 0. */
export function barWidths(counts: readonly number[]): number[] {
  const max = Math.max(0, ...counts);
  return counts.map((n) => (max > 0 ? Math.round((n / max) * 100) : 0));
}

/** Percent shares that add to exactly 100 (largest remainder), or all 0 when empty. */
export function shares(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((n) => (n * 100) / total);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - floor[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left-- <= 0) break;
    floor[i]++;
  }
  return floor;
}

export function npsTone(score: number): "ok" | "warn" | "live" {
  if (score >= 30) return "ok";
  if (score >= 0) return "warn";
  return "live";
}

export function formatAverage(avg: number, outOf: number): string {
  return avg < 0 ? "—" : `${avg.toFixed(1)} / ${outOf}`;
}
