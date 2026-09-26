/* What a rejoin reads back, kept pure.
 *
 * Chat, Q&A and polls are all persisted server-side and keyed on the participant's
 * identity (att_<joinKey> or user_<id>), so a reload, a new tab or a dropped connection
 * can ask for them again. The rules for folding that answer into what the room already
 * holds are here, where they can be tested without a live room:
 *
 *   draining the backlog   The chat endpoint pages at 300 lines. A client that stops
 *                          after the first page shows the OLDEST 300 of a long session
 *                          and never the conversation that is actually happening.
 *   Q&A history            A server snapshot plus whatever arrives live afterwards,
 *                          counted once; hidden questions stay hidden.
 *   unread                 History is not news. Only what arrived after this page
 *                          loaded counts toward a badge.
 *
 * No React and no livekit-client imports, so node can run the tests directly.
 */

import type { ChatBacklog, RoomQuestions, SessionQuestion } from "./api-types";

// ---------------------------------------------------------------- chat backlog

/** More than any client keeps (realtime.ts holds 500 lines), so the loop always
 *  reaches the present; bounded so a runaway `more` cannot spin forever. */
export const MAX_BACKLOG_PAGES = 40;

/** Reads the chat from `since` to the present, following `more`.
 *
 *  Returns every page's messages in order, the ids moderation removed (reported only
 *  for a cursor above zero — a reconnect), and the cursor reached. */
export async function drainBacklog(
  fetchPage: (since: number) => Promise<ChatBacklog>,
  since: number,
  maxPages = MAX_BACKLOG_PAGES,
): Promise<{ messages: ChatBacklog["messages"]; deleted: string[]; cursor: number }> {
  const messages: ChatBacklog["messages"] = [];
  const deleted = new Set<string>();
  let cursor = since;
  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(cursor);
    messages.push(...batch.messages);
    for (const id of batch.deleted ?? []) deleted.add(id);
    // A cursor that does not move would ask the same question forever.
    const moved = batch.cursor > cursor;
    cursor = Math.max(cursor, batch.cursor);
    if (!batch.more || !moved) break;
  }
  return { messages, deleted: [...deleted], cursor };
}

// ------------------------------------------------------------------- Q&A

export type HistorySender = { identity: string; name: string; role: "host" | "panelist" | "attendee" };

export type HistoryQuestion = {
  kind: "question";
  id: string;
  from: HistorySender;
  text: string;
  anonymous: boolean;
  at: number;
};

export type QuestionSnapshot = {
  questions: HistoryQuestion[];
  /** The server's count for each question and whether it includes the caller. */
  base: Record<string, { count: number; mine: boolean }>;
  answered: string[];
  mods: Record<string, { pinned: boolean; dismissed: boolean; answer: string }>;
};

function role(value: string | undefined): HistorySender["role"] {
  return value === "host" || value === "panelist" ? value : "attendee";
}

function clampText(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

/** Turns the room's question list into what useRealtime holds.
 *
 *  An anonymous question that is not the caller's arrives with no identity — the
 *  server strips it — and is given a placeholder that can never equal a real one, so
 *  "mine" stays false and no avatar colour is keyed on anybody. Questions the stage
 *  hid are marked dismissed, which is what takes one a client still holds off an
 *  attendee's screen. */
export function questionSnapshot(list: RoomQuestions): QuestionSnapshot {
  const out: QuestionSnapshot = { questions: [], base: {}, answered: [], mods: {} };
  for (const q of list.questions ?? []) {
    const id = clampText(q.id, 64);
    const text = clampText(q.text, 600);
    if (!id || !text) continue;
    out.questions.push({
      kind: "question",
      id,
      from: {
        identity: clampText(q.identity, 200) || `anonymous:${id}`,
        name: clampText(q.name, 80) || (q.anonymous ? "Anonymous" : "Guest"),
        role: role(q.role),
      },
      text,
      anonymous: q.anonymous === true,
      at: stamp(q),
    });
    out.base[id] = { count: Math.max(0, q.upvotes ?? 0), mine: q.votedByMe === true };
    if (q.answered) out.answered.push(id);
    out.mods[id] = {
      pinned: q.pinned === true,
      dismissed: q.dismissed === true,
      answer: clampText(q.answer, 600),
    };
  }
  for (const id of list.hidden ?? []) {
    out.mods[id] = { pinned: false, dismissed: true, answer: out.mods[id]?.answer ?? "" };
  }
  return out;
}

function stamp(q: SessionQuestion): number {
  const at = q.createdAt ? Date.parse(q.createdAt) : NaN;
  return Number.isNaN(at) ? 0 : at;
}

/** Merges snapshot questions into those already held, once each by id, oldest first,
 *  keeping at most `max`. A question already on screen keeps its object, so a card
 *  being read does not re-render into a different one. */
export function mergeQuestions<Q extends { id: string; at: number }>(
  current: readonly Q[],
  incoming: readonly Q[],
  max: number,
): Q[] {
  if (incoming.length === 0) return current as Q[];
  const byId = new Map(current.map((q) => [q.id, q]));
  for (const q of incoming) if (!byId.has(q.id)) byId.set(q.id, q);
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-max);
}

/** One question's votes: the server's count at the last snapshot, plus the voters
 *  heard live since then. The caller is not counted twice when their own vote is in
 *  both. */
export function tallyVotes(
  base: { count: number; mine: boolean } | undefined,
  live: ReadonlySet<string> | undefined,
  me: string,
): { votes: number; votedByMe: boolean } {
  const liveCount = live?.size ?? 0;
  const mineLive = live?.has(me) ?? false;
  const mineBase = base?.mine ?? false;
  return {
    votes: (base?.count ?? 0) + liveCount - (mineBase && mineLive ? 1 : 0),
    votedByMe: mineBase || mineLive,
  };
}

// ------------------------------------------------------------------ unread

/** How many items arrived after `since` and were not the caller's own.
 *
 *  History carries the time it was said — before this page loaded — so a reload
 *  shows no badge for a conversation already read in the previous tab, while lines
 *  said during a dropped connection (after the page loaded) still count as new. */
export function countSince(
  items: readonly { at: number; from: { identity: string } }[],
  since: number,
  me: string,
): number {
  let n = 0;
  for (const item of items) if (item.at >= since && item.from.identity !== me) n++;
  return n;
}
