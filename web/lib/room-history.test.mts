/* Tests for what a rejoin reads back — see room-history.ts.
 *
 * Run with `make test-web`. None of these can be produced on demand in a live room:
 * a session long enough to page, a double upvote from a reloaded tab, an anonymous
 * question read back by somebody else, a hidden question an attendee still holds.
 */

import {
  countSince,
  drainBacklog,
  mergeQuestions,
  questionSnapshot,
  tallyVotes,
} from "./room-history.ts";
import type { ChatBacklog, ChatMessage, RoomQuestions } from "./api-types.ts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

function msg(seq: number): ChatMessage {
  return {
    id: `m${seq}`,
    seq,
    senderId: "att_x",
    senderName: "X",
    senderRole: "attendee",
    message: `line ${seq}`,
    timestamp: "2026-09-27T10:00:00Z",
  } as ChatMessage;
}

/** A fake server over `total` messages, `page` at a time, like ChatBacklog. */
function server(total: number, page: number, deleted: string[] = []) {
  const asked: number[] = [];
  const fetchPage = async (since: number): Promise<ChatBacklog> => {
    asked.push(since);
    const rows: ChatMessage[] = [];
    for (let s = since + 1; s <= total && rows.length < page; s++) rows.push(msg(s));
    return {
      messages: rows,
      cursor: rows.length ? rows[rows.length - 1].seq : since,
      more: rows.length === page && rows[rows.length - 1].seq < total,
      ...(since > 0 ? { deleted } : {}),
    };
  };
  return { fetchPage, asked };
}

console.log("drainBacklog");
{
  const s = server(700, 300);
  const out = await drainBacklog(s.fetchPage, 0);
  eq(out.messages.length, 700, "a fresh join in a long session reaches the present, not just the first page");
  eq(out.messages[out.messages.length - 1].seq, 700, "…ending on the newest line");
  eq(out.cursor, 700, "…with the cursor at the newest line");
  eq(s.asked, [0, 300, 600], "…one request per page");
}
{
  const s = server(420, 300, ["m12"]);
  const out = await drainBacklog(s.fetchPage, 410);
  eq(out.messages.map((m) => m.seq), [411, 412, 413, 414, 415, 416, 417, 418, 419, 420], "a reconnect asks for exactly the gap");
  eq(out.deleted, ["m12"], "…and hears which held messages were deleted while it was away");
}
{
  const s = server(10, 300);
  const out = await drainBacklog(s.fetchPage, 10);
  eq(out.messages.length, 0, "nothing new is nothing new");
  eq(s.asked.length, 1, "…in one request");
}
{
  // A server that claims `more` without moving its cursor must not spin.
  let calls = 0;
  const stuck = async (): Promise<ChatBacklog> => {
    calls++;
    return { messages: [], cursor: 5, more: true };
  };
  await drainBacklog(stuck, 5);
  eq(calls, 1, "a cursor that does not move stops the loop");
  let capped = 0;
  const endless = async (since: number): Promise<ChatBacklog> => {
    capped++;
    return { messages: [msg(since + 1)], cursor: since + 1, more: true };
  };
  await drainBacklog(endless, 0, 3);
  eq(capped, 3, "and the page cap holds");
}

console.log("questionSnapshot");
const list: RoomQuestions = {
  questions: [
    {
      id: "q1", identity: "att_bob", name: "Bob", text: "Slides?", anonymous: false,
      answered: true, answer: "Emailed after", pinned: true, upvotes: 3, votedByMe: true,
      createdAt: "2026-09-27T10:00:00Z", role: "attendee",
    },
    {
      // Somebody else's anonymous question: the server has stripped the asker.
      id: "q2", identity: "", name: "", text: "Pricing?", anonymous: true,
      answered: false, upvotes: 0, createdAt: "2026-09-27T10:01:00Z",
    },
    {
      id: "q3", identity: "user_h", name: "Priya", text: "From Berlin?", anonymous: false,
      answered: false, upvotes: 1, createdAt: "2026-09-27T10:02:00Z", role: "host",
    },
  ],
  hidden: ["q9"],
};
{
  const snap = questionSnapshot(list);
  eq(snap.questions.map((q) => q.id), ["q1", "q2", "q3"], "every question comes back");
  eq(snap.base.q1, { count: 3, mine: true }, "the count and my own vote come back");
  eq(snap.answered, ["q1"], "answered state comes back");
  eq(snap.mods.q1, { pinned: true, dismissed: false, answer: "Emailed after" }, "pin and written answer come back");
  eq(snap.questions[1].from.identity.startsWith("anonymous:"), true, "an anonymous asker gets a placeholder, never a real identity");
  eq(snap.questions[1].from.name, "Anonymous", "…and no name");
  eq(snap.questions[2].from.role, "host", "the asker's role survives, for the badge");
  eq(snap.mods.q9?.dismissed, true, "a hidden question an attendee still holds is marked dismissed");
  eq(snap.questions[0].at, Date.parse("2026-09-27T10:00:00Z"), "questions keep the time they were asked");
}
{
  const bad = questionSnapshot({
    questions: [{ id: "", text: "x", name: "", anonymous: false, answered: false, upvotes: 0 }],
    hidden: [],
  } as RoomQuestions);
  eq(bad.questions.length, 0, "a row with no id is dropped rather than rendered");
}

console.log("mergeQuestions");
{
  const live = { id: "q3", at: 5, text: "live copy" };
  const merged = mergeQuestions(
    [live],
    [
      { id: "q1", at: 1, text: "a" },
      { id: "q3", at: 3, text: "history copy" },
    ],
    300,
  );
  eq(merged.map((q) => q.id), ["q1", "q3"], "merged once each, oldest first");
  eq(merged[1] === live, true, "a question already on screen keeps its object");
  eq(mergeQuestions([{ id: "a", at: 1 }], [{ id: "b", at: 2 }, { id: "c", at: 3 }], 2).map((q) => q.id), ["b", "c"], "capped to the newest");
}

console.log("tallyVotes");
{
  eq(tallyVotes({ count: 3, mine: true }, undefined, "me"), { votes: 3, votedByMe: true }, "a reload shows the server's count and my vote");
  eq(tallyVotes({ count: 3, mine: false }, new Set(["x"]), "me"), { votes: 4, votedByMe: false }, "a live vote after the snapshot adds one");
  eq(tallyVotes({ count: 3, mine: true }, new Set(["me"]), "me"), { votes: 3, votedByMe: true }, "my vote in both is counted once");
  eq(tallyVotes(undefined, new Set(["me", "x"]), "me"), { votes: 2, votedByMe: true }, "with no snapshot, the live voters are the count");
}

console.log("countSince");
{
  const joined = 1000;
  const items = [
    { at: 900, from: { identity: "att_a" } }, // history from before this page
    { at: 1500, from: { identity: "att_b" } }, // said during a dropped connection
    { at: 1600, from: { identity: "me" } }, // my own
  ];
  eq(countSince(items, joined, "me"), 1, "history is not unread; a line missed while disconnected is; mine never is");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
