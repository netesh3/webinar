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
 * Replayed items are folded into the room's own chat and Q&A, interleaved with what the new
 * audience says live, by the wall-clock moment each one "happens" in this session: the
 * moment position 0 played (the anchor) plus its offset.
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

function pollLine(item: ReplayItem): string {
  const p = item.poll;
  if (!p) return "";
  if (item.kind === "poll") return `Poll: ${p.question} (${p.options.join(" / ")})`;
  const total = p.total ?? 0;
  const parts = p.options.map((o, i) => {
    const n = p.counts?.[i] ?? 0;
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    return `${o} ${pct}%`;
  });
  let line = `Poll results: ${p.question} — ${parts.join(" · ")} (${total} ${total === 1 ? "vote" : "votes"})`;
  if (p.quiz && p.correct != null && p.options[p.correct] != null) {
    line += `. Correct answer: ${p.options[p.correct]}`;
  }
  return line;
}

/* The visible prefix of the timeline as the room's own messages.
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
      case "chat":
      case "poll":
      case "poll_results": {
        const text = it.kind === "chat" ? (it.text ?? "") : pollLine(it);
        if (!text) break;
        chat.push({
          kind: "chat",
          id: `replay-${it.id}`,
          from: {
            identity: `replay:${it.id}`,
            name: it.kind === "chat" ? it.name || (role === "attendee" ? "Attendee" : "Host") : "Poll",
            role: it.kind === "chat" ? role : "host",
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

/** An offset into the recording as the host's preview shows it: "4:05", "1:02:09". */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The line the host's preview shows for one item. */
export function previewText(item: ReplayItem): string {
  if (item.kind === "poll" || item.kind === "poll_results") return pollLine(item);
  return item.text ?? "";
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
