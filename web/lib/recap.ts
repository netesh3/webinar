/* The AI recap: the pure half.
 *
 * What the Results tab's recap card says when there is no recap yet, the action items as
 * text to paste, and how a chapter — seconds from when the SESSION went live — maps onto
 * a recording, which starts whenever somebody pressed Record and may be several takes
 * with gaps between them. The components (components/ai-recap-card.tsx, the player in
 * components/video-player.tsx) are only state and markup around these. */

import type { RecapActionItem, RecapChapter, SessionRecapResponse } from "./api-types.ts";

/** "1:05", or "1:02:05" from an hour. */
export function formatChapterTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** One take of a recording, as the player plays them: in order, concatenated. */
export type ChapterPart = { createdAt: string; durationMs: number };

/** A chapter placed on the player's timeline. */
export type PlayerChapter = { title: string; startSec: number; sessionSec: number };

/* chapterSeekTimes maps chapters onto a recording's playlist.
 *
 * Each take started (createdAt) some seconds after the session went live; its place in the
 * playlist is the sum of the takes before it. A chapter inside a take seeks to the same
 * moment in it. One that falls before a take (the recording started late, or in the gap
 * between two takes) seeks to the start of the next take; one after the last take is not
 * on this recording at all. When several land on the same second, the latest wins: it is
 * the one that describes what is actually playing there.
 *
 * Without the times to place it (no session start, a take with no createdAt) the recording
 * is taken to start with the session, which is what a single take pressed at go-live is. */
export function chapterSeekTimes(
  chapters: readonly RecapChapter[],
  sessionStartedAt: string | undefined,
  parts: readonly ChapterPart[],
): PlayerChapter[] {
  if (chapters.length === 0 || parts.length === 0) return [];
  const sessionStart = sessionStartedAt ? Date.parse(sessionStartedAt) : NaN;
  const known = Number.isFinite(sessionStart) && parts.every((p) => Number.isFinite(Date.parse(p.createdAt)));
  let offset = 0;
  /* A take may start before go-live (Record pressed backstage, or a clock a second or two
   * apart): its start is then negative, and the session's 0:00 lies inside it rather than
   * at its first frame. Only takes after the first are kept from overlapping the one
   * before. */
  let prevEnd = known ? -Infinity : 0;
  const spans = parts.map((p) => {
    const dur = Math.max(0, p.durationMs / 1000);
    const start = known ? Math.max(prevEnd, (Date.parse(p.createdAt) - sessionStart) / 1000) : prevEnd;
    const span = { start, end: start + dur, offset };
    offset += dur;
    prevEnd = span.end;
    return span;
  });
  const total = offset;

  const out: PlayerChapter[] = [];
  const sorted = [...chapters].sort((a, b) => a.startSec - b.startSec);
  for (const c of sorted) {
    const t = c.startSec;
    let seek: number | null = null;
    for (const s of spans) {
      if (t < s.start) {
        seek = s.offset;
        break;
      }
      if (t < s.end || (s.end === s.start && t === s.start)) {
        seek = s.offset + (t - s.start);
        break;
      }
    }
    if (seek === null || (total > 0 && seek >= total)) continue;
    const at = Math.round(seek);
    const last = out[out.length - 1];
    if (last && Math.abs(last.startSec - at) < 1) out.pop();
    out.push({ title: c.title, startSec: at, sessionSec: t });
  }
  return out;
}

/** The chapter playing at t seconds into the playlist, -1 before the first. */
export function chapterAt(chapters: readonly PlayerChapter[], t: number): number {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].startSec <= t) idx = i;
    else break;
  }
  return idx;
}

/** Action items as text to paste into notes or a message: the host's marked "(you)". */
export function actionItemsText(items: readonly RecapActionItem[]): string {
  return items
    .map((a) => `- ${a.text}${a.owner === "host" ? " (you)" : a.owner === "attendee" ? " (attendees)" : ""}`)
    .join("\n");
}

export type RecapEmptyState = {
  title: string;
  detail: string;
  /** Still being written: worth checking again shortly. */
  pending: boolean;
};

/* What the recap card says when there is no recap to show. Null when there is one.
 *
 * The recap is written automatically when a session ends; there is no button to ask for
 * another, so none of these tells the host to generate or regenerate anything. */
export function recapEmptyState(r: SessionRecapResponse): RecapEmptyState | null {
  if (r.status === "ready" && r.recap) return null;
  switch (r.reason) {
    case "not_ended":
      return {
        title: "The AI recap comes after the session",
        detail: "When this session ends, an AI recap is written automatically from what was said, the Q&A, polls and chat, and emailed to you.",
        pending: false,
      };
    case "waiting_transcript":
      return {
        title: "Still processing",
        detail: "Waiting for the full transcript, which takes up to 30 minutes after the session ends. The recap follows automatically, and we'll email it to you.",
        pending: true,
      };
    case "ai_off":
      return {
        title: "AI is switched off for this account",
        detail: "Ask us to turn on AI features and every session will get a recap automatically.",
        pending: false,
      };
    case "ai_session_off":
      return {
        title: "AI was off for this session",
        detail: "The AI switch in the room was off when this session ended, so it was kept out of AI and has no recap. Sessions with the switch on get one automatically.",
        pending: false,
      };
    case "ai_limit":
      return {
        title: "AI limit reached for this month",
        detail: "This session's recap wasn't written because this month's AI allowance is used up. It resets on the 1st.",
        pending: false,
      };
    case "empty":
      return {
        title: "Nothing to recap",
        detail: "Nothing was said, asked, polled or chatted in this session, so there was nothing for an AI recap.",
        pending: false,
      };
    case "ai_unavailable":
    case "failed":
      return {
        title: "The recap couldn't be written",
        detail: "The AI service didn't answer after several tries, so this session has no recap.",
        pending: false,
      };
  }
  if (r.status === "pending") {
    return {
      title: "Writing your AI recap…",
      detail: "It's usually ready a minute or two after the session ends. We'll email it to you too.",
      pending: true,
    };
  }
  return {
    title: "No AI recap for this session",
    detail: "AI recaps are written automatically after every session that ends with AI on. This one ended before they were.",
    pending: false,
  };
}

/** The line under the recap: where it came from. */
export function recapSourceLabel(source: string | undefined): string {
  switch (source) {
    case "server_transcript":
      return "Written from the full session transcript.";
    case "captions":
      return "Written from the live captions.";
    case "engagement_only":
      return "Written from the Q&A, polls and chat only.";
  }
  return "";
}
