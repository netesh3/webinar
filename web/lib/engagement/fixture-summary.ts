/* Aggregates the fixture world (fixtures.ts) into an EngagementSummary, using the same
 * definitions the server documents in api/types/engagement.go and plan §3. */

import type { EngagementActivity, EngagementPoll, EngagementSummary } from "../api-types.ts";
import { BUCKET_MIN, LOBBY_MIN, MARKERS, POLL_DEFS, REACTIONS, REGISTERED, SESSION_MIN, WEBINAR } from "./fixture-data.ts";
import { AXIS, TOOLS, type FixtureWorld } from "./fixtures.ts";
import { FORMULA_VERSION, TIER_ORDER, bandFor, sessionWeights } from "./score.ts";

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

type ActivityKey = "chat" | "qa" | "poll" | "reaction";

const ACTIVITY_OF: Record<string, ActivityKey | undefined> = {
  chat: "chat",
  question: "qa",
  upvote: "qa",
  hand: "qa",
  poll: "poll",
  quiz: "poll",
  reaction: "reaction",
};

export function summarise(world: FixtureWorld): EngagementSummary {
  const { people, questions, chats, votes } = world;
  const rows = people.map((p) => p.detail.row);
  const attended = rows.length;
  const liveAt = (m: number) => people.filter((p) => p.visits.some((v) => m >= v.from && m < v.to)).length;

  const retention = Array.from({ length: SESSION_MIN + LOBBY_MIN }, (_, i) => {
    const minute = i - LOBBY_MIN;
    return { minute, live: liveAt(minute) };
  });
  const peak = retention.reduce((b, r) => (r.live > b.live ? r : b), retention[0]);

  const activity: EngagementActivity = {
    bucketMin: 1,
    chat: Array(SESSION_MIN).fill(0),
    qa: Array(SESSION_MIN).fill(0),
    poll: Array(SESSION_MIN).fill(0),
    reaction: Array(SESSION_MIN).fill(0),
  };
  const buckets = SESSION_MIN / BUCKET_MIN;
  const emoji = new Map<string, number[]>(REACTIONS.map((e) => [e, Array(buckets).fill(0)]));
  for (const p of people)
    for (const e of p.detail.timeline) {
      const m = Math.floor(e.atSec / 60);
      const key = ACTIVITY_OF[e.kind];
      if (!key || m < 0 || m >= SESSION_MIN) continue;
      activity[key][m]++;
      if (e.emoji) emoji.get(e.emoji)![Math.floor(m / BUCKET_MIN)]++;
    }

  const watch = rows.map((r) => r.watchMin).sort((a, b) => a - b);
  const avgWatch = Math.round(sum(watch) / attended);

  const polls: EngagementPoll[] = POLL_DEFS.map((d, i) => ({ ...d, votes: votes[i], liveAtOpen: liveAt(d.minute) }));
  const pollOnly = polls.filter((p) => p.kind === "poll");
  const quizOnly = polls.filter((p) => p.kind === "quiz");
  const correctVotes = (p: EngagementPoll) => (p.correct === undefined ? 0 : p.votes[p.correct]);
  const hardest = quizOnly
    .map((p) => ({ p, pct: pctOf(correctVotes(p), sum(p.votes)) }))
    .sort((a, b) => a.pct - b.pct)[0];

  let drop = { minute: 0, lost: 0 };
  for (let m = 5; m < SESSION_MIN - 5; m++) {
    const lost = liveAt(m) - liveAt(m + 5);
    if (lost > drop.lost) drop = { minute: m, lost };
  }
  const keys: ActivityKey[] = ["chat", "qa", "poll", "reaction"];
  let best = { minute: 0, actions: 0, kind: "chat" };
  for (let m = 0; m < SESSION_MIN; m++) {
    const actions = sum(keys.map((k) => activity[k][m]));
    if (actions > best.actions) {
      const kind = keys.reduce((a, b) => (activity[b][m] > activity[a][m] ? b : a));
      best = { minute: m, actions, kind };
    }
  }

  const byChatter = new Map<string, number>();
  for (const c of chats) byChatter.set(c.name, (byChatter.get(c.name) ?? 0) + 1);
  const tierCount = (t: string) => rows.filter((r) => r.tier === t).length;
  const index = Math.round(sum(rows.map((r) => r.score)) / attended);
  const firstJoins = rows.map((r) => r.firstJoinMin);

  return {
    formulaVersion: FORMULA_VERSION,
    computedAt: WEBINAR.endedAt,
    state: "ready",
    webinar: { ...WEBINAR, status: "ended", sessionMin: SESSION_MIN },
    index,
    band: bandFor(index),
    kpis: {
      registered: REGISTERED,
      attended,
      noShows: REGISTERED - attended,
      attendanceRatePct: pctOf(attended, REGISTERED),
      avgWatchMin: avgWatch,
      medianWatchMin: watch[Math.floor(watch.length / 2)],
      avgWatchPct: pctOf(avgWatch, SESSION_MIN),
      stayedPastHalfPct: pctOf(rows.filter((r) => r.lastLeaveMin > SESSION_MIN / 2).length, attended),
      peakLive: peak.live,
      peakMinute: peak.minute,
      chatMessages: chats.length,
      chatters: byChatter.size,
      questions: questions.length,
      answeredQuestions: questions.filter((q) => q.answered).length,
      upvotes: sum(questions.map((q) => q.upvotes)),
      pollResponsePct: pctOf(sum(pollOnly.map((p) => sum(p.votes))), sum(pollOnly.map((p) => p.liveAtOpen))),
      quizAccuracyPct: pctOf(sum(quizOnly.map(correctVotes)), sum(quizOnly.map((p) => sum(p.votes)))),
      pollVoters: rows.filter((r) => r.counts.polls + r.counts.quizAnswered > 0).length,
      reactions: sum(activity.reaction),
      handRaises: sum(rows.map((r) => r.counts.hands)),
    },
    retentionStep: 1,
    retention,
    joinBucketMin: 5,
    joinHistogram: [-10, -5, 0, 5, 10, 15, 20, 25].map((fromMin, i, all) => {
      const open = i === all.length - 1;
      const count = firstJoins.filter((m) => m >= fromMin && (open || m < fromMin + 5)).length;
      return open ? { fromMin, count, open } : { fromMin, count };
    }),
    joinSplit: {
      early: rows.filter((r) => r.joinTiming === "early").length,
      onTime: rows.filter((r) => r.joinTiming === "on_time").length,
      late: rows.filter((r) => r.joinTiming === "late").length,
    },
    activity,
    markers: MARKERS,
    tiers: {
      high: tierCount(TIER_ORDER[0]),
      engaged: tierCount(TIER_ORDER[1]),
      passive: tierCount(TIER_ORDER[2]),
      risk: tierCount(TIER_ORDER[3]),
      noShow: REGISTERED - attended,
    },
    callouts: {
      ...(best.actions ? { bestMoment: best } : {}),
      ...(drop.lost ? { biggestDrop: drop } : {}),
      ...(hardest && hardest.pct < 60
        ? { needsRecap: { pollId: hardest.p.id, question: hardest.p.question, correctPct: hardest.pct } }
        : {}),
    },
    polls,
    reactions: {
      bucketMin: BUCKET_MIN,
      series: [...emoji].map(([e, counts]) => ({ emoji: e, total: sum(counts), counts })).sort((a, b) => b.total - a.total),
    },
    chat: {
      bucketMin: BUCKET_MIN,
      perBucket: Array.from({ length: buckets }, (_, b) =>
        chats.filter((c) => c.minute >= b * BUCKET_MIN && c.minute < (b + 1) * BUCKET_MIN).length,
      ),
      topChatters: [...byChatter]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([label, count]) => ({ label, count })),
      latest: [...chats].sort((a, b) => b.minute - a.minute).slice(0, 5),
    },
    questions: [...questions].sort((a, b) => b.upvotes - a.upvotes || a.minute - b.minute),
    weights: sessionWeights(TOOLS),
    axis: AXIS,
  };
}
