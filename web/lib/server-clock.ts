/* The server's clock as seen from this browser, for the edge latency overlay.
 *
 * NTP's simplest form: ask for the server's time, note when the request left and when the
 * answer arrived, and assume the answer was stamped halfway. The best of a few samples (the
 * one with the shortest round trip) wins, because a slow round trip is a wide error bar. */

export type ClockSample = { sentAt: number; receivedAt: number; serverNow: number };

/** Milliseconds to add to Date.now() to get the server's clock. */
export function clockOffset(samples: ClockSample[]): number {
  let best: ClockSample | null = null;
  for (const s of samples) {
    if (s.receivedAt < s.sentAt) continue;
    if (!best || s.receivedAt - s.sentAt < best.receivedAt - best.sentAt) best = s;
  }
  if (!best) return 0;
  return Math.round(best.serverNow - (best.sentAt + best.receivedAt) / 2);
}

/** HH:MM:SS.mmm in UTC, for a clock both the composite and the player draw identically. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}
