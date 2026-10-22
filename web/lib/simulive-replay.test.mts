/* Tests for the simulive engagement replay's scheduling: what is visible at a playback
 * position, a late joiner's catch-up, the shared clock, and the fold into chat and Q&A.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import type { ReplayItem } from "./api-types.ts";
import {
  formatOffset,
  interleave,
  previewText,
  replayMessages,
  sharedPositionMs,
  startPositionSec,
  steadyAnchor,
  visibleCount,
} from "./simulive-replay.ts";

const items: ReplayItem[] = [
  { id: "r1", kind: "chat", atMs: 5_000, name: "Coach Asha", role: "host", text: "Welcome" },
  { id: "r2", kind: "chat", atMs: 42_000, name: "Priya S.", role: "attendee", text: "Hi from Pune" },
  { id: "r3", kind: "question", atMs: 60_000, name: "Rahul V.", role: "attendee", text: "Slides?" },
  { id: "r4", kind: "question", atMs: 61_000, role: "attendee", text: "Pricing?", anonymous: true },
  { id: "r5", kind: "answer", atMs: 120_000, role: "host", text: "Yes, tonight", ref: "r3" },
  { id: "r6", kind: "poll", atMs: 200_000, role: "host", poll: { question: "Useful?", options: ["Yes", "No"] } },
  {
    id: "r7", kind: "poll_results", atMs: 260_000, role: "host", ref: "r6",
    poll: { question: "Useful?", options: ["Yes", "No"], counts: [3, 1], total: 4 },
  },
];

// ---- what is visible at a position
assert.equal(visibleCount(items, -1), 0);
assert.equal(visibleCount(items, 0), 0);
assert.equal(visibleCount(items, 4_999), 0);
assert.equal(visibleCount(items, 5_000), 1, "an item is visible from its own instant");
assert.equal(visibleCount(items, 60_500), 3);
assert.equal(visibleCount(items, 10_000_000), items.length);
assert.equal(visibleCount(items, Number.NaN), 0);
assert.equal(visibleCount([], 1000), 0);

// ---- the shared clock: a late joiner lands where everybody else is
const started = "2026-10-22T10:00:00Z";
const t = Date.parse(started);
assert.equal(sharedPositionMs(null, t), null);
assert.equal(sharedPositionMs("garbage", t), null);
assert.equal(sharedPositionMs(started, t - 5_000), 0, "a clock a little behind is not negative");
assert.equal(sharedPositionMs(started, t + 90_000), 90_000);
assert.equal(sharedPositionMs(started, t + 9_000_000, 600_000), 600_000, "clamped to the recording");

// The player seeks a late joiner; an on-time one starts at the top.
assert.equal(startPositionSec(null), null);
assert.equal(startPositionSec(1_500), null);
assert.equal(startPositionSec(90_000), 90);
assert.equal(startPositionSec(900_000, 600), 599.5, "never past the end");

// Late join catch-up: joining 70s in shows everything up to 70s at once, nothing after.
const late = visibleCount(items, sharedPositionMs(started, t + 70_000) ?? 0);
assert.equal(late, 4);
let view = replayMessages(items, late, t);
assert.deepEqual(view.chat.map((m) => m.text), ["Welcome", "Hi from Pune"]);
assert.equal(view.questions.length, 2);
assert.equal(view.questions[0].answered, false, "the answer has not been reached yet");
// ...then the answer arrives as the video reaches it, folded into its question.
view = replayMessages(items, visibleCount(items, 125_000), t);
assert.equal(view.questions[0].answered, true);
assert.equal(view.questions[0].answer, "Yes, tonight");
assert.equal(view.questions.length, 2, "an answer is not a question of its own");

// ---- the replayed messages themselves
view = replayMessages(items, items.length, t);
const [welcome, priya] = view.chat;
assert.equal(welcome.at, t + 5_000, "anchored: position 0 is the anchor");
assert.equal(welcome.from.role, "host");
assert.equal(priya.from.name, "Priya S.");
assert.equal(priya.from.role, "attendee");
assert.ok(view.chat.every((m) => m.replay && m.id.startsWith("replay-") && m.from.identity.startsWith("replay:")));
assert.equal(new Set(view.chat.map((m) => m.from.identity)).size, view.chat.length, "no identity links two lines");
assert.equal(view.questions[1].anonymous, true);
assert.equal(view.questions[1].from.name, "", "an anonymous question carries no name");
assert.ok(view.questions.every((q) => q.replay && !q.votedByMe && q.votes === 0));
assert.equal(view.chat[2].text, "Poll: Useful? (Yes / No)");
assert.equal(view.chat[3].text, "Poll results: Useful? — Yes 75% · No 25% (4 votes)");
const quiz = replayMessages(
  [{ id: "r1", kind: "poll_results", atMs: 0, role: "host",
    poll: { question: "2+2?", options: ["3", "4"], quiz: true, counts: [0, 1], total: 1, correct: 1 } }],
  1, 0,
);
assert.equal(quiz.chat[0].text, "Poll results: 2+2? — 3 0% · 4 100% (1 vote). Correct answer: 4");

// ---- interleaving with the live audience, in the order things happened in this session
const live = [{ at: t + 1_000, id: "a" }, { at: t + 50_000, id: "b" }];
const replayed = [{ at: t + 5_000, id: "x" }, { at: t + 50_000, id: "y" }, { at: t + 90_000, id: "z" }];
assert.deepEqual(interleave(live, replayed).map((m) => m.id), ["a", "x", "b", "y", "z"]);
assert.equal(interleave(live, []), live, "nothing replayed: the live list itself");

// ---- the anchor holds steady across ordinary playback, and moves on a seek
const a0 = steadyAnchor(null, t + 10_000, 10_000);
assert.equal(a0, t);
assert.equal(steadyAnchor(a0, t + 20_250, 20_000), a0, "a quarter-second of jitter does not move it");
assert.equal(steadyAnchor(a0, t + 20_000, 60_000), t - 40_000, "a seek does");

// ---- the host preview's labels
assert.equal(formatOffset(0), "0:00");
assert.equal(formatOffset(245_900), "4:05");
assert.equal(formatOffset(3_729_000), "1:02:09");
assert.equal(previewText(items[1]), "Hi from Pune");
assert.equal(previewText(items[5]), "Poll: Useful? (Yes / No)");

console.log("simulive-replay: ok");
