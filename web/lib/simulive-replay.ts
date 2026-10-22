/* Simulive engagement replay, the scheduling half (the server builds the timeline — see
 * api/internal/replay).
 *
 * The timeline is fetched once: every item with its offset into the recording (atMs), sorted.
 * The room schedules it against the video's OWN playback position rather than a wall clock,
 * so a viewer who buffers, or whose player started a second late, still sees each line as
 * the video reaches it:
 *
 *   visible = every item with atMs <= position
 *
 * A late joiner's player is first seeked to the shared position (sharedPositionMs — the
 * session's start is the simulive's shared clock), and the same rule then shows them
 * everything up to there at once: the catch-up. New items appear as the position passes
 * them.
 *
 * Replayed chat and questions are folded into the room's own chat and Q&A, interleaved with
 * what the new audience says live, by the wall-clock moment each one "happens" in this
 * session: the moment position 0 played (the anchor) plus its offset.
 *
 * Polls and quizzes are NOT chat lines: at a poll's moment the server opens a real poll in
 * this simulive (api/internal/api/simulive_live.go), and the room re-reads its Polls when the
 * video passes a poll or poll_close item (newlyCrossed). Reactions are played as a burst of
 * floating emoji when the video passes them — never during a late joiner's catch-up.
 *
 * Nothing plays before the server says the session started (simuliveWaiting): a player with
 * no start would begin at 0:00 on its own, and every viewer would be on a clock of their own.
 *
 * Pure so node can test it — simulive-replay.test.mts, run by `make test-web`. */

import type { ReplayItem } from "./api-types.ts";
import type { ChatMessage, Question } from "./realtime.ts";

/** How many items are visible at this playback position. Items are sorted by atMs. */
export function visibleCount(items: readonly Pick<ReplayItem, "atMs">[], positionMs: number): number {
  if (!Number.isFinite(positionMs) || positionMs < 0) return 0;
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].atMs <= positionMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Where everybody is in the recording now: the time since the session started, clamped
 *  to the recording. Null when the session has not started (or the start is unreadable). */
export function sharedPositionMs(
  startedAt: string | null | undefined,
  nowMs: number,
  durationMs = 0,
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  let pos = Math.max(0, nowMs - start);
  if (durationMs > 0) pos = Math.min(pos, durationMs);
  return pos;
}

/** Where a joining player should start, in seconds, or null to start at the beginning.
 *  The first few seconds are not worth a seek; past the end, the last moment. */
export function startPositionSec(
  sharedMs: number | null,
  mediaDurationSec?: number,
  minSeekMs = 3000,
): number | null {
  if (sharedMs == null || sharedMs < minSeekMs) return null;
  let sec = sharedMs / 1000;
  if (mediaDurationSec && Number.isFinite(mediaDurationSec) && mediaDurationSec > 0) {
    sec = Math.min(sec, Math.max(0, mediaDurationSec - 0.5));
  }
  return sec;
}

/** The anchor (the wall-clock ms at which position 0 played), kept steady: a new reading
 *  only replaces the old one when they disagree by more than `toleranceMs` — a seek, a long
 *  stall — so the times on replayed lines do not jitter with every timeupdate. */
export function steadyAnchor(previous: number | null, nowMs: number, positionMs: number, toleranceMs = 2000): number {
  const next = nowMs - positionMs;
  if (previous == null || Math.abs(previous - next) > toleranceMs) return next;
  return previous;
}

/** The line the host's preview shows for a poll item. The timeline carries no tally — the
 *  simulive's audience votes in its own copy — and a quiz's answer only in the preview. */
function pollLine(item: ReplayItem): string {
  const p = item.poll;
  if (!p) return "";
  const what = p.quiz ? "Quiz" : "Poll";
  if (item.kind === "poll") {
    let line = `${what} opens: ${p.question} (${p.options.join(" / ")})`;
    if (p.quiz && p.correct != null && p.options[p.correct] != null) line += ` — answer: ${p.options[p.correct]}`;
    return line;
  }
  return p.quiz ? `Quiz closes, answer revealed: ${p.question}` : `Poll closes, results shared: ${p.question}`;
}

/** A reaction burst as one line: "👏 6 · ❤️ 1". */
export function reactionLine(item: Pick<ReplayItem, "reactions">): string {
  return (item.reactions ?? []).map((r) => `${r.emoji} ${r.count}`).join(" · ");
}

/* The visible prefix of the timeline as the room's own messages: chat and Q&A only (polls are
 * the room's real polls, reactions float).
 *
 * Ids and identities are prefixed "replay-" / "replay:" so they can never collide with a live
 * message, a live participant or each other — and carry nothing of the original person (the
 * server sent none). Every replayed attendee shares one identity per item, so no avatar
 * colour links two lines to the same person either. An answer folds into its question. */
export function replayMessages(
  items: readonly ReplayItem[],
  count: number,
  anchorMs: number,
): { chat: ChatMessage[]; questions: Question[] } {
  const chat: ChatMessage[] = [];
  const questions: Question[] = [];
  const byItem = new Map<string, Question>();
  const n = Math.min(count, items.length);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const at = anchorMs + it.atMs;
    const role = it.role === "host" || it.role === "panelist" ? it.role : "attendee";
    switch (it.kind) {
      case "chat": {
        const text = it.text ?? "";
        if (!text) break;
        chat.push({
          kind: "chat",
          id: `replay-${it.id}`,
          from: {
            identity: `replay:${it.id}`,
            name: it.name || (role === "attendee" ? "Attendee" : "Host"),
            role,
          },
          destination: "everyone",
          text,
          at,
          seq: 0,
          replay: true,
        });
        break;
      }
      case "question": {
        const q: Question = {
          kind: "question",
          id: `replay-${it.id}`,
          from: { identity: `replay:${it.id}`, name: it.anonymous ? "" : it.name || "Attendee", role },
          text: it.text ?? "",
          anonymous: Boolean(it.anonymous),
          at,
          votes: 0,
          answered: false,
          votedByMe: false,
          pinned: false,
          dismissed: false,
          answer: "",
          replay: true,
        };
        byItem.set(it.id, q);
        questions.push(q);
        break;
      }
      case "answer": {
        const q = it.ref ? byItem.get(it.ref) : undefined;
        if (q) {
          q.answered = true;
          q.answer = it.text ?? "";
        }
        break;
      }
    }
  }
  return { chat, questions };
}

/** How recent a passed item must be to be PLAYED (a reaction floated, a poll re-read) rather
 *  than merely shown: a late joiner's catch-up passes minutes of items at once, and replaying
 *  every burst of applause from before they arrived would be noise. */
export const FRESH_MS = 6_000;

/** The items the position passed since the last tick (indices prev..next of the sorted
 *  timeline) that are recent enough to play. A seek backwards passes nothing. */
export function newlyCrossed<T extends Pick<ReplayItem, "atMs">>(
  items: readonly T[],
  prevCount: number,
  nextCount: number,
  positionMs: number,
  freshMs = FRESH_MS,
): T[] {
  if (nextCount <= prevCount) return [];
  const out: T[] = [];
  for (let i = Math.max(0, prevCount); i < Math.min(nextCount, items.length); i++) {
    if (items[i].atMs >= positionMs - freshMs) out.push(items[i]);
  }
  return out;
}

/** Whether passing these items should make the room re-read its polls: a replayed poll
 *  opened or closed. */
export function crossesPoll(items: readonly Pick<ReplayItem, "kind">[]): boolean {
  return items.some((it) => it.kind === "poll" || it.kind === "poll_close");
}

/* A replayed burst as taps on this screen: each emoji a few times (a tap already draws
 * several copies — reaction-queue.ts), spread across the burst's window, the most-sent first.
 * Bounded both ways, so a room of five hundred clapping replays as applause and not as a
 * minute of it. */
export function reactionTaps(
  item: Pick<ReplayItem, "reactions">,
  windowMs = 5_000,
  maxPerEmoji = 3,
  maxTotal = 6,
): { emoji: string; delayMs: number }[] {
  const plan: string[] = [];
  for (const r of item.reactions ?? []) {
    const n = Math.min(Math.max(0, Math.round(r.count)), maxPerEmoji);
    for (let i = 0; i < n && plan.length < maxTotal; i++) plan.push(r.emoji);
  }
  if (plan.length === 0) return [];
  const step = plan.length > 1 ? windowMs / plan.length : 0;
  return plan.map((emoji, i) => ({ emoji, delayMs: Math.round(i * step) }));
}

/** An offset into the recording as the host's preview shows it: "4:05", "1:02:09". */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The host's "jump to" box: "4:05", "1:02:09", "245" (seconds) or "4m" → ms; null when it
 *  is not a time. */
export function parseOffset(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+)\s*m(?:in)?$/.exec(s);
  if (m) return Number(m[1]) * 60_000;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  const parts = s.split(":").map(Number);
  if (parts.slice(1).some((p) => p > 59)) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec * 1000;
}

/** The line the host's preview shows for one item. */
export function previewText(item: ReplayItem): string {
  if (item.kind === "poll" || item.kind === "poll_close") return pollLine(item);
  if (item.kind === "reaction") return reactionLine(item);
  return item.text ?? "";
}

/* ---- before the start: one shared clock, strictly.
 *
 * A simulive's player never starts without the server's started_at: before it, the room is a
 * waiting screen (a countdown to the scheduled start, chat open when the doors are), and when
 * the session starts every open player begins at the shared position at once. */

/** Whether a simulive room is still waiting for its start. */
export function simuliveWaiting(simulive: boolean, startedAt: string | null | undefined): boolean {
  if (!simulive) return false;
  return !startedAt || Number.isNaN(Date.parse(startedAt));
}

/** The waiting screen's line: a countdown to the scheduled start, then "any moment" (the
 *  server is starting it), or the host's to start. */
export function waitingLabel(startsAt: string | null | undefined, nowMs: number, manual = false): string {
  if (manual) return "Waiting for the host to start the session";
  const start = startsAt ? Date.parse(startsAt) : Number.NaN;
  if (Number.isNaN(start) || start - nowMs <= 0) return "Starting any moment";
  const left = Math.ceil((start - nowMs) / 1000);
  return `Starting in ${formatOffset(left * 1000)}`;
}

/** How long to wait before asking the server whether the session has started: often around
 *  the start (asking is also what starts it, with no scheduler), rarely long before it, and
 *  steadily for one the host starts. */
export function waitingPollMs(startsAt: string | null | undefined, nowMs: number, manual = false): number {
  if (manual) return 10_000;
  const start = startsAt ? Date.parse(startsAt) : Number.NaN;
  if (Number.isNaN(start)) return 10_000;
  const left = start - nowMs;
  if (left <= 0) return 3_000;
  return Math.min(Math.max(left, 1_000), 60_000);
}

/** Live and replayed messages in one conversation, in the order they happened in this
 *  session. Stable: at the same instant, live stays before replayed. */
export function interleave<T extends { at: number }>(live: readonly T[], replayed: readonly T[]): T[] {
  if (replayed.length === 0) return live as T[];
  if (live.length === 0) return replayed as T[];
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < live.length || j < replayed.length) {
    if (j >= replayed.length || (i < live.length && live[i].at <= replayed[j].at)) out.push(live[i++]);
    else out.push(replayed[j++]);
  }
  return out;
}
