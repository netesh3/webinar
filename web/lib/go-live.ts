import { formatTime, tzLabel } from "@/lib/format";

/* How early Go live may open a scheduled webinar.
 *
 * The same fifteen minutes the API enforces (hostStartLead in host.go). The
 * schedule form's hour lead is a different rule and does not belong here. */
export const GO_LIVE_LEAD_MS = 15 * 60 * 1000;

/** The instant Go live opens: fifteen minutes before the scheduled start. */
export function goLiveOpensAt(startsAt: string): Date | null {
  const t = new Date(startsAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t - GO_LIVE_LEAD_MS);
}

/** True once now is at or after fifteen minutes before the start.
 *
 *  `now` is null until the clock is safe to read (see useNow). Until then the
 *  answer is false, so a scheduled Go live does not flash enabled and then lock. */
export function canGoLive(
  startsAt: string,
  now: number | null,
  durationMin?: number,
): boolean {
  if (now == null) return false;
  const opens = goLiveOpensAt(startsAt);
  if (!opens) return false;
  if (now < opens.getTime()) return false;
  /* Once the scheduled end has passed there is nothing to go live for. A
   * missing duration leaves the old answer, so a caller that has not been
   * told the length cannot accidentally lock a session that is still open. */
  if (durationMin != null && Number.isFinite(durationMin)) {
    const end = new Date(startsAt).getTime() + durationMin * 60_000;
    if (Number.isFinite(end) && now >= end) return false;
  }
  return true;
}

/** Shown beside a disabled Go live. The clock is the webinar's own zone. */
export function goLiveWaitReason(startsAt: string, timeZone: string): string {
  const minutes = GO_LIVE_LEAD_MS / 60_000;
  const opens = goLiveOpensAt(startsAt);
  if (!opens) return `Opens ${minutes} minutes before start`;
  const iso = opens.toISOString();
  return `Opens ${minutes} minutes before start (${formatTime(iso, timeZone)} ${tzLabel(iso, timeZone)})`;
}
