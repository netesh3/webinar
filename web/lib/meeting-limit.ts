/* Whether a session that has ended was ended by its maximum length, not by the host.
 *
 * Every webinar has a start and a maximum (the 3-hour default when nobody set one), so
 * "ended, with both" was true for every ending and the host pressing End got "Maximum
 * Meeting Length Reached — 3 hours" (2026-10-20). It is the limit only if the session ran
 * that long: the sweeper that ends it runs every 30-60s, so within a minute of the limit. */
export const LIMIT_SLACK_MS = 60 * 1000;
export function endedByLimit(o: {
  status: string | null | undefined;
  startedAt: string | null | undefined;
  endedAt: string | null | undefined;
  maxDurationMin: number | null | undefined;
}): boolean {
  if (o.status !== "ended" || !o.startedAt || !o.endedAt || !o.maxDurationMin) return false;
  const ran = new Date(o.endedAt).getTime() - new Date(o.startedAt).getTime();
  return Number.isFinite(ran) && ran >= o.maxDurationMin * 60 * 1000 - LIMIT_SLACK_MS;
}
