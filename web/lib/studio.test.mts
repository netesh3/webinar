/* node --experimental-strip-types --no-warnings lib/studio.test.mts */
import assert from "node:assert/strict";
import type { ClipPlan, StudioRecording } from "./api-types.ts";
import {
  aspectClass,
  clipStatus,
  clipsMadeText,
  cyclePlan,
  dayKey,
  formatChip,
  parseDay,
  planBucket,
  planGroups,
  planOf,
  planProblem,
  recordingAction,
  recordingHref,
  recordingStatus,
  studioView,
  weekStart,
} from "./studio.ts";

// The view in the address; anything else is Recordings.
assert.equal(studioView("plan"), "plan");
assert.equal(studioView("clips"), "clips");
assert.equal(studioView(null), "recordings");
assert.equal(studioView("nonsense"), "recordings");

const rec = (over: Partial<StudioRecording>): StudioRecording => ({
  id: "r1",
  slug: "money",
  topic: "Money basics",
  kind: "live",
  sessionAt: "2026-10-20T10:00:00Z",
  createdAt: "2026-10-20T10:00:00Z",
  durationMs: 600000,
  takes: 1,
  thumbPartId: "r1",
  highlightsStatus: "not_started",
  highlights: 0,
  reelsStatus: "not_started",
  reels: 0,
  clipsReady: 0,
  clipsPending: 0,
  clipsFailed: 0,
  ...over,
});

// One line, and one action, per state.
assert.deepEqual(recordingStatus(rec({})), { text: "Not analysed yet" });
assert.equal(recordingAction(rec({})), "find");
assert.deepEqual(recordingStatus(rec({ highlightsStatus: "processing" })), { text: "Finding highlights…", pending: true });
assert.equal(recordingAction(rec({ highlightsStatus: "processing" })), "busy");
assert.equal(
  recordingStatus(rec({ highlightsStatus: "ready", highlights: 6, reels: 2, clipsReady: 1, clipsPending: 2 })).text,
  "6 highlights · 2 reels · 1 clip made · 2 on the way",
);
assert.equal(recordingStatus(rec({ highlightsStatus: "ready", highlights: 1 })).text, "1 highlight");
assert.equal(recordingStatus(rec({ highlightsStatus: "ready" })).text, "No highlights found");
assert.equal(recordingAction(rec({ highlightsStatus: "ready" })), "make");
assert.equal(recordingAction(rec({ highlightsStatus: "ai_unavailable" })), "retry");
assert.equal(recordingAction(rec({ highlightsStatus: "failed" })), "retry");
assert.equal(recordingAction(rec({ highlightsStatus: "no_transcript" })), "open");
assert.equal(recordingStatus(rec({ highlightsStatus: "ai_off" })).problem, true);
assert.equal(recordingStatus(rec({ highlightsStatus: "something new" })).text, "Couldn't find highlights. Try again");
assert.equal(clipsMadeText({ clipsReady: 0, clipsPending: 0 }), "");
assert.equal(recordingHref("my slug", "r/1"), "/host/my%20slug?tab=recording&recording=r%2F1");

// Clips.
assert.equal(aspectClass("9x16"), "aspect-[9/16]");
assert.equal(aspectClass("1x1"), "aspect-square");
assert.equal(aspectClass("16x9"), "aspect-video");
assert.equal(formatChip("9x16"), "9:16");
assert.equal(clipStatus({ status: "queued", progress: 0 }).text, "Waiting for the video server");
assert.equal(clipStatus({ status: "processing", progress: 40 }).text, "Making… 40%");
assert.equal(clipStatus({ status: "failed", progress: 0, error: "Too long." }).text, "Too long.");
assert.equal(clipStatus({ status: "ready", progress: 100 }).tone, "ok");

// The status pill: Idea → Scheduled (needs a day) → Posted → Idea.
const idea = planOf(null);
assert.deepEqual(idea, { platforms: [], plannedOn: "", status: "idea", note: "" });
assert.equal(cyclePlan(idea), null);
const dated = { ...idea, plannedOn: "2026-11-03" };
assert.equal(cyclePlan(dated)?.status, "scheduled");
assert.equal(cyclePlan({ ...dated, status: "scheduled" })?.status, "posted");
assert.equal(cyclePlan({ ...idea, status: "posted" })?.status, "idea");
assert.equal(planProblem({ ...idea, status: "scheduled" }), "Pick a date to schedule it.");
assert.equal(planProblem(dated), null);

// Days are the browser's calendar; weeks start on Monday.
assert.equal(dayKey(new Date(2026, 9, 24)), "2026-10-24");
assert.equal(parseDay("2026-10-24")?.getDate(), 24);
assert.equal(parseDay("24/10/2026"), null);
assert.equal(dayKey(weekStart(new Date(2026, 9, 24))), "2026-10-19"); // a Saturday
assert.equal(dayKey(weekStart(new Date(2026, 9, 25))), "2026-10-19"); // Sunday
assert.equal(dayKey(weekStart(new Date(2026, 9, 26))), "2026-10-26"); // Monday

const today = new Date(2026, 9, 24); // Saturday 24 October 2026
assert.equal(planBucket(undefined, today), "unplanned");
assert.equal(planBucket("2026-10-18", today), "earlier");
assert.equal(planBucket("2026-10-19", today), "this-week");
assert.equal(planBucket("2026-10-25", today), "this-week");
assert.equal(planBucket("2026-10-26", today), "next-week");
assert.equal(planBucket("2026-11-01", today), "next-week");
assert.equal(planBucket("2026-11-02", today), "later");

const plan = (plannedOn?: string): ClipPlan => ({ platforms: [], plannedOn, status: "idea", note: "" });
const item = (id: string, createdAt: string, p: ClipPlan | null) => ({ id, clip: { createdAt }, plan: p });
const groups = planGroups(
  [
    item("a", "2026-10-01T00:00:00Z", null),
    item("b", "2026-10-02T00:00:00Z", plan("2026-11-20")),
    item("c", "2026-10-03T00:00:00Z", plan("2026-10-23")),
    item("d", "2026-10-04T00:00:00Z", plan("2026-10-20")),
    item("e", "2026-10-05T00:00:00Z", plan()),
  ],
  today,
);
assert.deepEqual(
  groups.map((g) => [g.label, g.items.map((i) => i.id).join("")]),
  [
    ["This week", "dc"],
    ["Later", "b"],
    ["Unplanned", "ea"],
  ],
);

console.log("studio: ok");
