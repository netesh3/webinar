/* The Studio, the pure half: which view is open, what a recording's or clip's state reads as
 * in one line, which one action a card offers, and the content plan (the status cycle and
 * the week buckets). The data is api/internal/api/studio.go's.
 *
 *   node --experimental-strip-types --no-warnings lib/studio.test.mts */
import {
  ClipFormatSquare,
  ClipFormatVertical,
  ClipPlanIdea,
  ClipPlanPosted,
  ClipPlanScheduled,
  ClipPlatformLinkedIn,
  ClipPlatformReels,
  ClipPlatformShorts,
  ClipPlatformTikTok,
  ClipPlatformYouTube,
  StudioNotStarted,
} from "./api-types.ts";
import type { Clip, ClipPlan, ClipPlanInput, StudioRecording } from "./api-types.ts";

// ---------------------------------------------------------------- views

export const STUDIO_VIEWS = ["recordings", "clips", "plan"] as const;
export type StudioView = (typeof STUDIO_VIEWS)[number];

export const STUDIO_VIEW_LABELS: Record<StudioView, string> = {
  recordings: "Recordings",
  clips: "Clips",
  plan: "Plan",
};

/** ?view= as a view; anything else is Recordings. */
export function studioView(q: string | null | undefined): StudioView {
  return (STUDIO_VIEWS as readonly string[]).includes(q ?? "") ? (q as StudioView) : "recordings";
}

// ---------------------------------------------------------------- recordings

/** Where a recording's highlights stand, in one short line. pending: being found now. */
export function recordingStatus(r: StudioRecording): { text: string; pending?: boolean; problem?: boolean } {
  switch (r.highlightsStatus) {
    case StudioNotStarted:
      return { text: "Not analysed yet" };
    case "processing":
      return { text: "Finding highlights…", pending: true };
    case "ready": {
      const parts: string[] = [];
      parts.push(r.highlights === 0 ? "No highlights found" : count(r.highlights, "highlight"));
      if (r.reels > 0) parts.push(count(r.reels, "reel"));
      const made = clipsMadeText(r);
      if (made) parts.push(made);
      return { text: parts.join(" · ") };
    }
    case "ai_off":
      return { text: "AI is off for this account", problem: true };
    case "ai_session_off":
      return { text: "AI was off for this session", problem: true };
    case "ai_limit":
      return { text: "AI allowance used up this month", problem: true };
    case "ai_unavailable":
      return { text: "AI didn't answer. Try again", problem: true };
    case "no_transcript":
      return { text: "Nothing was captioned", problem: true };
    case "not_ready":
      return { text: "Not ready to play yet", problem: true };
    case "not_ended":
      return { text: "Session hasn't ended", problem: true };
  }
  return { text: "Couldn't find highlights. Try again", problem: true };
}

/** "2 clips made · 1 on the way", or "" when none. */
export function clipsMadeText(r: Pick<StudioRecording, "clipsReady" | "clipsPending">): string {
  const parts: string[] = [];
  if (r.clipsReady > 0) parts.push(`${count(r.clipsReady, "clip")} made`);
  if (r.clipsPending > 0) parts.push(`${r.clipsPending} on the way`);
  return parts.join(" · ");
}

/** The one action a recording card offers: find its highlights (again, after a hiccup), wait
 *  while they are found, or make clips from them (or open it, when there is nothing to find). */
export type RecordingAction = "find" | "retry" | "busy" | "make" | "open";

export function recordingAction(r: StudioRecording): RecordingAction {
  switch (r.highlightsStatus) {
    case StudioNotStarted:
      return "find";
    case "processing":
      return "busy";
    case "ready":
      return "make";
    case "ai_unavailable":
    case "failed":
      return "retry";
  }
  // AI off, no captions, allowance used: finding again would only be refused.
  return "open";
}

/** The session's Recording tab, with this recording open in the player and its highlights. */
export function recordingHref(slug: string, recordingId: string): string {
  return `/host/${encodeURIComponent(slug)}?tab=recording&recording=${encodeURIComponent(recordingId)}`;
}

// ---------------------------------------------------------------- clips

/** The frame a clip's thumbnail is drawn in, as a Tailwind aspect class. */
export function aspectClass(format: string): string {
  if (format === ClipFormatVertical) return "aspect-[9/16]";
  if (format === ClipFormatSquare) return "aspect-square";
  return "aspect-video";
}

/** "9:16" for a format id. */
export function formatChip(format: string): string {
  return format.replace("x", ":");
}

/** A clip's state in one line. */
export function clipStatus(c: Pick<Clip, "status" | "progress" | "error">): {
  text: string;
  tone: "neutral" | "brand" | "ok" | "live";
} {
  switch (c.status) {
    case "ready":
      return { text: "Ready", tone: "ok" };
    case "processing":
      return { text: c.progress > 0 ? `Making… ${c.progress}%` : "Making…", tone: "brand" };
    case "failed":
      return { text: c.error || "Couldn't be made", tone: "live" };
  }
  return { text: "Waiting for the video server", tone: "neutral" };
}

// ---------------------------------------------------------------- the plan

/** The platforms a clip can be planned for, in the order they are shown. */
export const PLAN_PLATFORMS: { id: string; label: string }[] = [
  { id: ClipPlatformReels, label: "Reels" },
  { id: ClipPlatformShorts, label: "Shorts" },
  { id: ClipPlatformTikTok, label: "TikTok" },
  { id: ClipPlatformLinkedIn, label: "LinkedIn" },
  { id: ClipPlatformYouTube, label: "YouTube" },
];

export function platformLabel(id: string): string {
  return PLAN_PLATFORMS.find((p) => p.id === id)?.label ?? id;
}

export const PLAN_STATUS_LABELS: Record<string, string> = {
  [ClipPlanIdea]: "Idea",
  [ClipPlanScheduled]: "Scheduled",
  [ClipPlanPosted]: "Posted",
};

/** A clip's plan, or the empty one it starts from. */
export function planOf(plan: ClipPlan | null | undefined): ClipPlanInput {
  return {
    platforms: plan?.platforms ?? [],
    plannedOn: plan?.plannedOn ?? "",
    status: plan?.status || ClipPlanIdea,
    note: plan?.note ?? "",
  };
}

/** The plan after a tap on its status pill: Idea → Scheduled → Posted → Idea. Scheduled needs
 *  a day, so without one this is null: the caller asks for a day instead. */
export function cyclePlan(plan: ClipPlanInput): ClipPlanInput | null {
  const next =
    plan.status === ClipPlanIdea ? ClipPlanScheduled : plan.status === ClipPlanScheduled ? ClipPlanPosted : ClipPlanIdea;
  if (next === ClipPlanScheduled && !plan.plannedOn) return null;
  return { ...plan, status: next };
}

/** Why a plan cannot be saved, in the server's words, or null when it can. */
export function planProblem(plan: ClipPlanInput): string | null {
  if (plan.status === ClipPlanScheduled && !plan.plannedOn) return "Pick a date to schedule it.";
  return null;
}

/** A day as YYYY-MM-DD in the browser's own calendar. */
export function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** YYYY-MM-DD as a local date at midnight, or null. */
export function parseDay(s: string | undefined | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Monday of the week the day falls in, at midnight. */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (out.getDay() + 6) % 7; // Monday 0 … Sunday 6
  out.setDate(out.getDate() - back);
  return out;
}

export type PlanBucket = "earlier" | "this-week" | "next-week" | "later" | "unplanned";

export const PLAN_BUCKET_LABELS: Record<PlanBucket, string> = {
  earlier: "Earlier",
  "this-week": "This week",
  "next-week": "Next week",
  later: "Later",
  unplanned: "Unplanned",
};

const BUCKET_ORDER: PlanBucket[] = ["earlier", "this-week", "next-week", "later", "unplanned"];

/** Which bucket a planned day falls in, seen from today. */
export function planBucket(plannedOn: string | undefined, today: Date): PlanBucket {
  const day = parseDay(plannedOn);
  if (!day) return "unplanned";
  const thisWeek = weekStart(today);
  const nextWeek = new Date(thisWeek);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const after = new Date(thisWeek);
  after.setDate(after.getDate() + 14);
  if (day < thisWeek) return "earlier";
  if (day < nextWeek) return "this-week";
  if (day < after) return "next-week";
  return "later";
}

/** The plan as a list: buckets in order (empty ones left out), each by day then newest made
 *  first among the undated. */
export function planGroups<T extends { plan?: ClipPlan | null; clip: { createdAt: string } }>(
  items: T[],
  today: Date,
): { bucket: PlanBucket; label: string; items: T[] }[] {
  const by = new Map<PlanBucket, T[]>();
  for (const it of items) {
    const b = planBucket(it.plan?.plannedOn, today);
    by.set(b, [...(by.get(b) ?? []), it]);
  }
  return BUCKET_ORDER.filter((b) => by.has(b)).map((b) => ({
    bucket: b,
    label: PLAN_BUCKET_LABELS[b],
    items: [...(by.get(b) ?? [])].sort((x, y) => {
      const dx = x.plan?.plannedOn ?? "";
      const dy = y.plan?.plannedOn ?? "";
      if (dx !== dy) return dx < dy ? -1 : 1;
      return x.clip.createdAt < y.clip.createdAt ? 1 : x.clip.createdAt > y.clip.createdAt ? -1 : 0;
    }),
  }));
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
