/* Engagement Score, formula v2 — the TypeScript twin of api/internal/engagement.
 *
 * Both implementations are checked against api/internal/engagement/testdata/score_cases.json,
 * so the fixture page and the server can never disagree about what a number means.
 * Pure and React-free: node runs the tests against this file directly. */

import type { EngagementComponent, EngagementWeight } from "../api-types.ts";

export const FORMULA_VERSION = 2;

export type Tier = "high" | "engaged" | "passive" | "risk";
export type Band = "excellent" | "strong" | "good" | "attention";
export type ComponentKey = "watch" | "polls" | "quiz" | "chat" | "qa" | "reactions" | "hands" | "survey";

/** Which interactive tools the session actually used. Watch always applies. */
export interface SessionTools {
  polls: boolean;
  quiz: boolean;
  chat: boolean;
  qa: boolean;
  reactions: boolean;
  hands: boolean;
  /** A post-event survey was sent (live or closed). Absent means no. */
  survey?: boolean;
}

export interface ScoreInput {
  watchSec: number;
  sessionSec: number;
  chats: number;
  questions: number;
  upvotes: number;
  pollsPresent: number;
  pollsAnswered: number;
  quizPresent: number;
  quizCorrect: number;
  reactions: number;
  hands: number;
  /** Submitted the survey (full credit), or only opened a survey link (half). */
  surveyDone?: boolean;
  surveyClicked?: boolean;
}

export const CAPS = { chat: 5, questions: 2, upvotes: 5, reactions: 10, hands: 1 } as const;

/** Credit for opening a link survey without submitting the rating. */
export const SURVEY_CLICK_CREDIT = 0.5;

interface Definition {
  key: ComponentKey;
  label: string;
  base: number;
  rule: string;
}

export const COMPONENTS: readonly Definition[] = [
  { key: "watch", label: "Watch time", base: 40, rule: "share of the session watched" },
  { key: "polls", label: "Polls answered", base: 15, rule: "of the polls they were present for" },
  { key: "quiz", label: "Quiz accuracy", base: 10, rule: "unanswered counts as wrong" },
  { key: "chat", label: "Chat", base: 10, rule: `max at ${CAPS.chat} messages` },
  { key: "qa", label: "Q&A", base: 10, rule: "asking counts double an upvote" },
  { key: "reactions", label: "Reactions", base: 5, rule: `max at ${CAPS.reactions}` },
  { key: "hands", label: "Raised hand", base: 5, rule: "once is enough" },
  { key: "survey", label: "Survey", base: 5, rule: "completed the post-event survey; opening a survey link counts half" },
];

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Survey applies once one was sent; polls and quiz also need the person present for one. */
function applies(key: ComponentKey, tools: SessionTools, i: ScoreInput): boolean {
  switch (key) {
    case "watch":
      return true;
    case "polls":
      return tools.polls && i.pollsPresent > 0;
    case "quiz":
      return tools.quiz && i.quizPresent > 0;
    case "survey":
      return tools.survey === true;
    default:
      return tools[key];
  }
}

function ratioOf(key: ComponentKey, i: ScoreInput): number {
  switch (key) {
    case "watch":
      return i.sessionSec > 0 ? clamp01(i.watchSec / i.sessionSec) : 0;
    case "polls":
      return clamp01(i.pollsAnswered / i.pollsPresent);
    case "quiz":
      return clamp01(i.quizCorrect / i.quizPresent);
    case "chat":
      return Math.min(i.chats, CAPS.chat) / CAPS.chat;
    case "qa":
      return clamp01(i.questions / CAPS.questions + (0.5 * i.upvotes) / CAPS.upvotes);
    case "reactions":
      return Math.min(i.reactions, CAPS.reactions) / CAPS.reactions;
    case "hands":
      return Math.min(i.hands, CAPS.hands);
    case "survey":
      return i.surveyDone ? 1 : i.surveyClicked ? SURVEY_CLICK_CREDIT : 0;
  }
}

function detailOf(key: ComponentKey, i: ScoreInput): string {
  switch (key) {
    case "watch":
      return `${Math.round(i.watchSec / 60)} of ${Math.round(i.sessionSec / 60)} min`;
    case "polls":
      return `${i.pollsAnswered} of ${i.pollsPresent} answered`;
    case "quiz":
      return `${i.quizCorrect} of ${i.quizPresent} correct`;
    case "chat":
      return `${plural(i.chats, "message")} (cap ${CAPS.chat})`;
    case "qa":
      return `${i.questions} asked · ${plural(i.upvotes, "upvote")}`;
    case "reactions":
      return `${i.reactions} (cap ${CAPS.reactions})`;
    case "hands":
      return i.hands > 0 ? "Yes" : "No";
    case "survey":
      return i.surveyDone ? "Completed" : i.surveyClicked ? "Opened the survey link" : "Not completed";
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function exactComponents(tools: SessionTools, input: ScoreInput) {
  const used = COMPONENTS.filter((c) => applies(c.key, tools, input));
  const total = used.reduce((s, c) => s + c.base, 0);
  return used.map((c) => {
    const weight = (c.base * 100) / total;
    const ratio = ratioOf(c.key, input);
    return { def: c, weight, ratio, points: weight * ratio };
  });
}

/** The components that applied to this person, weights redistributed to sum to 100.
 *  Weight and points are rounded to 0.1 for display only. */
export function scoreComponents(tools: SessionTools, input: ScoreInput): EngagementComponent[] {
  return exactComponents(tools, input).map(({ def, weight, ratio, points }) => ({
    key: def.key,
    label: def.label,
    weight: round1(weight),
    ratio,
    points: round1(points),
    detail: detailOf(def.key, input),
  }));
}

/** Rounded once from the unrounded points, so display rounding never moves the total. */
export function engagementScore(tools: SessionTools, input: ScoreInput): number {
  return Math.round(exactComponents(tools, input).reduce((s, c) => s + c.points, 0));
}

/** Session-level weights as the formula strip shows them: 0 for a tool that wasn't used. */
export function sessionWeights(tools: SessionTools): EngagementWeight[] {
  const on = (key: ComponentKey) => key === "watch" || tools[key] === true;
  const total = COMPONENTS.filter((c) => on(c.key)).reduce((s, c) => s + c.base, 0);
  return COMPONENTS.map((c) => ({
    key: c.key,
    label: c.label,
    baseWeight: c.base,
    weight: on(c.key) ? round1((c.base * 100) / total) : 0,
    rule: c.rule,
  }));
}

export function tierFor(score: number): Tier {
  if (score >= 75) return "high";
  if (score >= 50) return "engaged";
  if (score >= 25) return "passive";
  return "risk";
}

export function bandFor(index: number): Band {
  if (index >= 70) return "excellent";
  if (index >= 55) return "strong";
  if (index >= 40) return "good";
  return "attention";
}

export const TIER_ORDER: readonly Tier[] = ["high", "engaged", "passive", "risk"];

export interface TierMeta {
  label: string;
  hint: string;
  chip: string;
  dot: string;
  color: string;
}

export const TIER_META: Record<Tier, TierMeta> = {
  high: { label: "Highly engaged", hint: "Score 75+", chip: "bg-ok-soft text-ok border-ok/25", dot: "bg-ok", color: "#0b8a4b" },
  engaged: { label: "Engaged", hint: "Score 50–74", chip: "bg-brand-soft text-brand border-brand-line", dot: "bg-brand", color: "#0b5cff" },
  passive: { label: "Passive", hint: "Score 25–49", chip: "bg-warn-soft text-warn border-warn/25", dot: "bg-warn", color: "#a15c00" },
  risk: { label: "At risk", hint: "Score under 25", chip: "bg-live-soft text-live border-live/25", dot: "bg-live", color: "#d93025" },
};

export const BAND_META: Record<Band, { label: string; tone: string; color: string }> = {
  excellent: { label: "Excellent", tone: "text-ok", color: "#0b8a4b" },
  strong: { label: "Strong", tone: "text-ok", color: "#0b8a4b" },
  good: { label: "Good", tone: "text-brand", color: "#0b5cff" },
  attention: { label: "Needs attention", tone: "text-warn", color: "#a15c00" },
};

/** The wire types carry tiers and bands as plain strings; unknown values degrade safely. */
export function asTier(value: string): Tier {
  return (TIER_ORDER as readonly string[]).includes(value) ? (value as Tier) : "risk";
}

export function asBand(value: string, index: number): Band {
  return value in BAND_META ? (value as Band) : bandFor(index);
}
