/* Suggested highlights under a recording, the pure half: times as the host reads and types
 * them, whether an adjusted range still makes a clip, the engagement chips, and what each
 * status says. The picking is the server's (api/internal/api/highlights.go).
 *
 *   node --experimental-strip-types --no-warnings lib/highlights.test.mts */
import { HighlightMaxSec, HighlightMinSec } from "./api-types.ts";
import type { HighlightSignals } from "./api-types.ts";

/** Seconds as m:ss, or h:mm:ss from an hour; tenths dropped. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** What the host typed ("12:05", "1:02:03", "725", "12:05.5") in seconds, or null. */
export function parseClock(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
  const [whole, frac] = t.split(".");
  const parts = whole.split(":").map(Number);
  if (parts.slice(1).some((p) => p > 59)) return null;
  const sec = parts.reduce((acc, p) => acc * 60 + p, 0);
  return frac ? sec + Number(`0.${frac}`) : sec;
}

/** Length as "45 s" or "1 min 5 s". */
export function lengthText(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const r = s % 60;
  return r ? `${Math.floor(s / 60)} min ${r} s` : `${Math.floor(s / 60)} min`;
}

/** Why an adjusted range does not make a clip, or null when it does. part is the take the
 *  suggestion lies in, on the player's timeline: a clip is cut from one file. */
export function rangeProblem(
  start: number | null,
  end: number | null,
  part: { start: number; end: number },
): string | null {
  if (start === null || end === null) return "Type the times as minutes and seconds, like 12:05.";
  if (end <= start) return "The end has to come after the start.";
  if (end - start < HighlightMinSec) return `A clip is at least ${HighlightMinSec} seconds long.`;
  if (end - start > HighlightMaxSec + 0.05) return `A clip is at most ${HighlightMaxSec} seconds long.`;
  if (start < part.start - 0.05 || end > part.end + 0.05) {
    return `Keep it between ${clock(part.start)} and ${clock(part.end)}: the recording was stopped and started again there.`;
  }
  return null;
}

function n(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the audience did during a highlight, as chips. Empty when they did nothing. */
export function signalChips(s: HighlightSignals): string[] {
  const out: string[] = [];
  if (s.reactions) out.push(n(s.reactions, "reaction"));
  if (s.chat) out.push(n(s.chat, "chat message"));
  if (s.questions) out.push(n(s.questions, "question"));
  if (s.polls) out.push(n(s.polls, "poll"));
  return out;
}

/** What the highlights panel says instead of a list; null when the list is there. */
export function highlightsStatusText(status: string): { text: string; pending?: boolean } | null {
  switch (status) {
    case "ready":
      return null;
    case "processing":
      return { text: "Finding the best moments… this takes up to a minute.", pending: true };
    case "not_ended":
      return { text: "Highlights are found once the session has ended." };
    case "ai_off":
      return { text: "AI isn't switched on for this account." };
    case "ai_session_off":
      return { text: "AI was switched off for this session, so its recording isn't read by AI." };
    case "ai_limit":
      return { text: "This month's AI allowance is used up. Highlights can be found again next month." };
    case "ai_unavailable":
      return { text: "The AI didn't answer. Try again in a minute." };
    case "no_transcript":
      return { text: "Nothing said in this recording was captioned, so there are no moments to pick from. Keep the room's AI switch on next time." };
    case "not_ready":
      return { text: "Highlights are found once the recording is ready to play." };
  }
  return { text: "The highlights couldn't be found. Try again in a minute." };
}
