/* The server's clock as seen from this browser: for the edge latency overlay, and for a
 * simulive's shared clock (lib/use-server-clock.ts) — where everybody is in the recording is
 * "server now minus the session's start", and a device clock that is a few seconds out would
 * otherwise put that viewer a few seconds away from everybody else.
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

/** Takes `count` samples one after another from `fetchServerNow` (GET /api/time's `now`),
 *  skipping any that fail. `clientNow` is the local clock (Date.now). */
export async function measureClock(
  fetchServerNow: () => Promise<number>,
  count = 3,
  clientNow: () => number = Date.now,
): Promise<ClockSample[]> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < count; i++) {
    const sentAt = clientNow();
    try {
      const serverNow = await fetchServerNow();
      if (Number.isFinite(serverNow)) samples.push({ sentAt, receivedAt: clientNow(), serverNow });
    } catch {
      // A missed sample narrows nothing; keep the rest.
    }
  }
  return samples;
}

/* The page's one measured offset, shared by everything that needs the server's clock. 0 —
 * the device clock as it is — until measured. */
let sharedOffsetMs = 0;

/** Milliseconds to add to Date.now() to get the server's clock, as last measured. */
export function serverOffsetMs(): number {
  return sharedOffsetMs;
}

export function setServerOffsetMs(ms: number): void {
  if (Number.isFinite(ms)) sharedOffsetMs = ms;
}

/** The server's clock now, in Unix ms: the local clock corrected by the measured offset. */
export function serverNow(clientNow: number = Date.now(), offsetMs: number = sharedOffsetMs): number {
  return clientNow + offsetMs;
}

/** HH:MM:SS.mmm in UTC, for a clock both the composite and the player draw identically. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}
