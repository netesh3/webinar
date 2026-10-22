/* Tests for the simulive engagement replay's scheduling: what is visible at a playback
 * position, a late joiner's catch-up, the shared clock, and the fold into chat and Q&A.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import type { ReplayItem } from "./api-types.ts";
import {
  crossesPoll,
  formatOffset,
  interleave,
  newlyCrossed,
  parseOffset,
  previewText,
  reactionTaps,
  replayMessages,
  sharedPositionMs,
  simuliveWaiting,
  startPositionSec,
  steadyAnchor,
  visibleCount,
  waitingLabel,
  waitingPollMs,
} from "./simulive-replay.ts";

const items: ReplayItem[] = [
  { id: "r1", kind: "chat", atMs: 5_000, name: "Coach Asha", role: "host", text: "Welcome" },
  { id: "r2", kind: "chat", atMs: 42_000, name: "Priya S.", role: "attendee", text: "Hi from Pune" },
  { id: "r3", kind: "question", atMs: 60_000, name: "Rahul V.", role: "attendee", text: "Slides?" },
  { id: "r4", kind: "question", atMs: 61_000, role: "attendee", text: "Pricing?", anonymous: true },
  { id: "r5", kind: "answer", atMs: 120_000, role: "host", text: "Yes, tonight", ref: "r3" },
  { id: "r6", kind: "poll", atMs: 200_000, role: "host", poll: { question: "Useful?", options: ["Yes", "No"] } },
  { id: "r7", kind: "poll_close", atMs: 260_000, role: "host", ref: "r6", poll: { question: "Useful?", options: ["Yes", "No"] } },
  { id: "r8", kind: "reaction", atMs: 262_000, reactions: [{ emoji: "👏", count: 9 }, { emoji: "❤️", count: 2 }] },
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
// Polls, quizzes and reactions are never chat lines: the room's real polls, and floating emoji.
assert.equal(view.chat.length, 2, "only the chat is chat");
assert.ok(!view.chat.some((m) => /Poll|Quiz|👏/.test(m.text)));

// ---- what the position passing an item PLAYS: recent ones only, never a catch-up
assert.deepEqual(newlyCrossed(items, 0, 8, 268_000).map((i) => i.id), ["r8"], "a late joiner replays no old applause, and no polls");
assert.deepEqual(newlyCrossed(items, 5, 7, 261_000).map((i) => i.id), ["r7"]);
assert.deepEqual(newlyCrossed(items, 7, 5, 100_000), [], "a seek back passes nothing");
assert.equal(crossesPoll(newlyCrossed(items, 5, 6, 200_500)), true, "a poll's moment re-reads the polls");
assert.equal(crossesPoll(newlyCrossed(items, 7, 8, 262_100)), false);
const taps = reactionTaps(items[7]);
assert.deepEqual(taps.map((x) => x.emoji), ["👏", "👏", "👏", "❤️", "❤️"], "capped per emoji, most-sent first");
assert.deepEqual(taps.map((x) => x.delayMs), [0, 1000, 2000, 3000, 4000], "spread across the window");
assert.equal(reactionTaps({ reactions: [{ emoji: "🎉", count: 500 }] }, 5000, 99, 6).length, 6, "and in total");
assert.deepEqual(reactionTaps({}), []);

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
assert.equal(previewText(items[5]), "Poll opens: Useful? (Yes / No)");
assert.equal(previewText(items[6]), "Poll closes, results shared: Useful?");
assert.equal(previewText(items[7]), "👏 9 · ❤️ 2");
assert.equal(
  previewText({ id: "q", kind: "poll", atMs: 0, poll: { question: "2+2?", options: ["3", "4"], quiz: true, correct: 1 } }),
  "Quiz opens: 2+2? (3 / 4) — answer: 4",
);
assert.equal(parseOffset("4:05"), 245_000);
assert.equal(parseOffset(" 1:02:09 "), 3_729_000);
assert.equal(parseOffset("245"), 245_000);
assert.equal(parseOffset("4m"), 240_000);
assert.equal(parseOffset("4:75"), null);
assert.equal(parseOffset("soon"), null);
assert.equal(parseOffset(""), null);

// ---- before the start: no player without the server's start, one clock for everyone
assert.equal(simuliveWaiting(true, null), true, "no start: wait, never play from 0:00");
assert.equal(simuliveWaiting(true, "garbage"), true);
assert.equal(simuliveWaiting(true, started), false);
assert.equal(simuliveWaiting(false, null), false, "not a simulive: not this rule");
assert.equal(waitingLabel(started, t - 125_000), "Starting in 2:05");
assert.equal(waitingLabel(started, t + 1_000), "Starting any moment");
assert.equal(waitingLabel(started, t - 5_000, true), "Waiting for the host to start the session");
assert.equal(waitingPollMs(started, t - 600_000), 60_000, "long before: rarely");
assert.equal(waitingPollMs(started, t - 20_000), 20_000, "wake at the start");
assert.equal(waitingPollMs(started, t + 1), 3_000, "past it: often, since asking is what starts it");
assert.equal(waitingPollMs(started, t, true), 10_000);
// Everybody waiting starts at the same place once it starts, however long they waited.
assert.equal(startPositionSec(sharedPositionMs(started, t + 42_000)), 42);

console.log("simulive-replay: ok");
