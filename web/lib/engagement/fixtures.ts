/* A seeded, internally consistent sample webinar in the API's own shapes.
 *
 * Port of the design mock's generator: the retention curve, heatmap, KPIs and each drawer
 * all derive from the same visits and events, and a fixed seed makes every render identical
 * (no hydration mismatch, stable screenshots). Scores use the real formula (score.ts). */

import type {
  EngagementAttendeeDetail,
  EngagementAttendeeRow,
  EngagementAxis,
  EngagementCounts,
  EngagementQuestion,
  EngagementTimelineEvent,
} from "../api-types.ts";
import {
  ATTENDEES,
  BUCKET_MIN,
  CHAT_LINES,
  FIRST,
  GREETINGS,
  LAST,
  LOBBY_MIN,
  MARKERS,
  POLL_DEFS,
  QUESTION_LINES,
  REACTIONS,
  SESSION_MIN,
} from "./fixture-data.ts";
import { engagementScore, scoreComponents, tierFor, type SessionTools } from "./score.ts";

export const TOOLS: SessionTools = { polls: true, quiz: true, chat: true, qa: true, reactions: true, hands: true };

export const AXIS: EngagementAxis = {
  bucketMin: BUCKET_MIN,
  startMin: -LOBBY_MIN,
  columns: (SESSION_MIN + LOBBY_MIN) / BUCKET_MIN,
  lobbyColumns: LOBBY_MIN / BUCKET_MIN,
};

interface Visit {
  from: number;
  to: number;
}

export interface FixturePerson {
  detail: EngagementAttendeeDetail;
  visits: Visit[];
}

export interface FixtureWorld {
  people: FixturePerson[];
  questions: EngagementQuestion[];
  chats: { minute: number; name: string; text: string }[];
  votes: number[][];
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Archetype = "stayer" | "dropper" | "rejoiner" | "brief" | "late";

export function generateWorld(seed = 42): FixtureWorld {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

  const people: FixturePerson[] = [];
  const questions: EngagementQuestion[] = [];
  const askedBy = new Map<string, string>();
  const chats: FixtureWorld["chats"] = [];
  const votes = POLL_DEFS.map((p) => p.options.map(() => 0));
  const used = new Set<string>();

  for (let n = 0; n < ATTENDEES; n++) {
    let name = "";
    do name = `${pick(FIRST)} ${pick(LAST)}`;
    while (used.has(name));
    used.add(name);
    const identity = `att_${String(n + 1).padStart(3, "0")}`;

    const r = rnd();
    const arch: Archetype =
      r < 0.5 ? "stayer" : r < 0.64 ? "late" : r < 0.78 ? "rejoiner" : r < 0.92 ? "dropper" : "brief";
    const p = Math.min(1, rnd() * 0.7 + (arch === "stayer" ? 0.45 : arch === "rejoiner" ? 0.2 : 0.05));

    const jr = rnd();
    let join =
      arch === "late" ? between(8, 26) : jr < 0.32 ? between(-9, -1) : jr < 0.86 ? between(0, 5) : between(6, 14);
    const visits: Visit[] = [];
    if (arch === "stayer" || arch === "late") {
      visits.push({ from: join, to: rnd() < 0.8 ? SESSION_MIN : between(48, 59) });
    } else if (arch === "rejoiner") {
      const drop = between(14, 30);
      const back = drop + between(3, 12);
      visits.push({ from: join, to: drop }, { from: back, to: rnd() < 0.7 ? SESSION_MIN : between(50, 59) });
    } else if (arch === "dropper") {
      visits.push({ from: join, to: between(Math.max(join + 8, 12), 34) });
    } else {
      join = Math.max(join, 0);
      visits.push({ from: join, to: join + between(3, 9) });
    }

    const present = (m: number) => visits.some((v) => m >= v.from && m < v.to);
    const watchMin = visits.reduce((s, v) => s + Math.max(0, Math.min(v.to, SESSION_MIN) - Math.max(v.from, 0)), 0);

    const events: EngagementTimelineEvent[] = [];
    // Seconds within the minute come from position, not the PRNG, so the sequence stays stable.
    const at = (m: number) => m * 60 + ((n * 13 + events.length * 7) % 60);
    visits.forEach((v, i) => {
      events.push({ atSec: v.from * 60, kind: "join", text: i === 0 ? (v.from < 0 ? "Joined early (lobby)" : "Joined") : "Rejoined" });
      if (v.to < SESSION_MIN) events.push({ atSec: v.to * 60, kind: "leave", text: "Left the room" });
    });

    let greeted = false;
    for (let m = 0; m < SESSION_MIN; m++) {
      if (!present(m)) continue;
      const qa = m >= 44 && m < 53;
      const boost = MARKERS.some((k) => m >= k.minute && m <= k.minute + 1) ? 2.2 : 1;
      if (rnd() < p * (m < 3 ? 0.25 : qa ? 0.09 : 0.035)) {
        const text = m < 3 && !greeted ? pick(GREETINGS) : pick(CHAT_LINES);
        if (m < 3) greeted = true;
        events.push({ atSec: at(m), kind: "chat", text });
        chats.push({ minute: m, name, text });
      }
      if (rnd() < p * 0.05 * boost + (m >= 53 && m <= 55 ? p * 0.12 : 0)) {
        const emoji = m >= 53 ? pick(["🎉", "❤️", "👏"] as const) : pick(REACTIONS);
        events.push({ atSec: at(m), kind: "reaction", text: `Reacted ${emoji}`, emoji });
      }
      if (m >= 20 && rnd() < p * (qa ? 0.045 : 0.006)) {
        const text = pick(QUESTION_LINES);
        const id = `qa${questions.length + 1}`;
        askedBy.set(id, identity);
        questions.push({ id, minute: m, name, text, upvotes: 0, answered: false });
        events.push({ atSec: at(m), kind: "question", text: `Asked: “${text}”` });
      }
      if (qa && questions.length && rnd() < p * 0.12) {
        const q = pick(questions);
        if (askedBy.get(q.id) !== identity) {
          q.upvotes++;
          events.push({ atSec: at(m), kind: "upvote", text: `Upvoted “${q.text}”` });
        }
      }
      if (qa && rnd() < p * 0.02) events.push({ atSec: at(m), kind: "hand", text: "Raised hand" });
    }

    let pollsPresent = 0;
    let quizPresent = 0;
    POLL_DEFS.forEach((poll, pi) => {
      if (!present(poll.minute) && !present(poll.minute + 1)) return;
      if (poll.kind === "quiz") quizPresent++;
      else pollsPresent++;
      if (rnd() > 0.45 + 0.5 * p) return;
      let choice: number;
      if (poll.kind === "quiz" && poll.correct !== undefined) {
        const skill = poll.id === "q2" ? 0.25 + 0.45 * p : 0.45 + 0.45 * p;
        choice =
          rnd() < skill ? poll.correct : (poll.correct + between(1, poll.options.length - 1)) % poll.options.length;
      } else {
        const w = poll.id === "p1" ? [0.38, 0.27, 0.23, 0.12] : [0.3, 0.36, 0.22, 0.12];
        let x = rnd();
        choice = Math.max(0, w.findIndex((v) => (x -= v) < 0));
      }
      votes[pi][choice]++;
      const minute = poll.minute + (rnd() < 0.6 ? 0 : 1);
      const isQuiz = poll.kind === "quiz";
      events.push({
        atSec: at(minute),
        kind: isQuiz ? "quiz" : "poll",
        text: `${isQuiz ? "Quiz" : "Poll"}: ${poll.options[choice]}`,
        ...(isQuiz ? { correct: choice === poll.correct } : {}),
      });
    });

    events.sort((a, b) => a.atSec - b.atSec);
    const count = (k: string) => events.filter((e) => e.kind === k).length;
    const counts: EngagementCounts = {
      chats: count("chat"),
      questions: count("question"),
      upvotes: count("upvote"),
      polls: count("poll"),
      pollsPresent,
      quizCorrect: events.filter((e) => e.kind === "quiz" && e.correct).length,
      quizAnswered: count("quiz"),
      quizPresent,
      reactions: count("reaction"),
      hands: count("hand"),
    };
    const input = {
      watchSec: watchMin * 60,
      sessionSec: SESSION_MIN * 60,
      chats: counts.chats,
      questions: counts.questions,
      upvotes: counts.upvotes,
      pollsPresent,
      pollsAnswered: counts.polls,
      quizPresent,
      quizCorrect: counts.quizCorrect,
      reactions: counts.reactions,
      hands: counts.hands,
    };
    const score = engagementScore(TOOLS, input);

    const presence: number[] = [];
    const intensity: number[] = [];
    for (let b = 0; b < AXIS.columns; b++) {
      const lo = AXIS.startMin + b * BUCKET_MIN;
      let here = 0;
      for (let m = lo; m < lo + BUCKET_MIN; m++) if (present(m)) here++;
      presence.push(Math.round((here / BUCKET_MIN) * 100));
      intensity.push(
        events.filter((e) => e.atSec >= lo * 60 && e.atSec < (lo + BUCKET_MIN) * 60 && e.kind !== "join" && e.kind !== "leave")
          .length,
      );
    }

    const [fn, ln] = name.split(" ");
    const firstJoinMin = visits[0].from;
    const row: EngagementAttendeeRow = {
      identity,
      name,
      email: `${fn.toLowerCase()}.${ln.toLowerCase().replace(/[^a-z]/g, "")}@example.com`,
      score,
      tier: tierFor(score),
      watchMin,
      firstJoinMin,
      lastLeaveMin: visits[visits.length - 1].to,
      joinTiming: firstJoinMin < 0 ? "early" : firstJoinMin <= 5 ? "on_time" : "late",
      visits: visits.length,
      counts,
      presence,
      intensity,
    };
    const byEmoji = new Map<string, number>();
    for (const e of events) if (e.emoji) byEmoji.set(e.emoji, (byEmoji.get(e.emoji) ?? 0) + 1);

    people.push({
      visits,
      detail: {
        row,
        components: scoreComponents(TOOLS, input),
        visits: visits.map((v) => ({ fromMin: v.from, toMin: v.to })),
        timeline: events,
        whatsAppOptIn: rnd() < 0.68,
        reactions: [...byEmoji].map(([label, c]) => ({ label, count: c })),
        sessionMin: SESSION_MIN,
      },
    });
  }

  // A few answered live and the rest left for follow-up — the usual shape of a Q&A.
  questions
    .sort((a, b) => b.upvotes - a.upvotes || a.minute - b.minute)
    .forEach((q, i) => (q.answered = i < 5 || (i % 3 === 0 && i < 10)));

  return { people, questions, chats, votes };
}
