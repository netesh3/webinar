import { formatTime, tzLabel } from "@/lib/format";

/* How early Go live may open a scheduled webinar.
 *
 * The same five minutes the API enforces (hostStartLead in host.go). The
 * schedule form's hour lead is a different rule and does not belong here. */
export const GO_LIVE_LEAD_MS = 5 * 60 * 1000;

/** The instant Go live opens: five minutes before the scheduled start. */
export function goLiveOpensAt(startsAt: string): Date | null {
  const t = new Date(startsAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t - GO_LIVE_LEAD_MS);
}

/** True once now is at or after five minutes before the start.
 *
 *  `now` is null until the clock is safe to read (see useNow). Until then the
 *  answer is false, so a scheduled Go live does not flash enabled and then lock. */
export function canGoLive(startsAt: string, now: number | null): boolean {
  if (now == null) return false;
  const opens = goLiveOpensAt(startsAt);
  if (!opens) return false;
  return now >= opens.getTime();
}

/** Shown beside a disabled Go live. The clock is the webinar's own zone. */
export function goLiveWaitReason(startsAt: string, timeZone: string): string {
  const opens = goLiveOpensAt(startsAt);
  if (!opens) return "Opens 5 minutes before start";
  const iso = opens.toISOString();
  return `Opens 5 minutes before start (${formatTime(iso, timeZone)} ${tzLabel(iso, timeZone)})`;
}
