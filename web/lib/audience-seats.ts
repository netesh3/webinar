/* The host's "N / limit" for a live webinar's audience (participants panel). The count is the
 * one the join check turns people away with (store.AudienceAdmission): attendees watching or
 * just let in, never the stage. */

export type SeatTone = "ok" | "near" | "full";

export type SeatsView = { text: string; tone: SeatTone; percent: number };

/* Near at 90% (or within five seats of a small limit), full at the limit. The panel shows the
 * tone so a host sees "nearly full" before an attendee is told the webinar is. */
export function seatsView(count: number, limit: number): SeatsView | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  const percent = Math.min(100, Math.round((n / limit) * 100));
  const tone: SeatTone = n >= limit ? "full" : n >= Math.min(limit * 0.9, limit - 5) ? "near" : "ok";
  const text = `${n.toLocaleString()} / ${limit.toLocaleString()} seats`;
  return { text, tone, percent };
}
