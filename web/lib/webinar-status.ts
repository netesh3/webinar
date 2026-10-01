/* Whether a scheduled webinar is already over because it never went live.
 *
 * The server decides this when it reads the row (store.markLapsed). The host
 * preview has no server, so it applies the same instant here: start plus
 * duration, compared as an absolute time. The webinar's time zone only
 * changes how that instant is printed. A live session stays live, and a
 * draft stays a draft. */

export function scheduledEndMs(startsAt: string, durationMin: number): number | null {
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start) || !Number.isFinite(durationMin)) return null;
  return start + durationMin * 60_000;
}

/** True when this scheduled webinar's end has passed and it never started. */
export function lapsedWithoutLive(
  w: {
    status: string;
    startedAt?: string;
    didntGoLive?: boolean;
    startsAt: string;
    durationMin: number;
  },
  now: number,
): boolean {
  if (w.didntGoLive) return true;
  if (w.status !== "scheduled" || w.startedAt) return false;
  const end = scheduledEndMs(w.startsAt, w.durationMin);
  return end != null && end <= now;
}

/** The shape the host list renders. A lapsed scheduled row becomes completed. */
export function presentForHostList<
  T extends {
    status: string;
    startedAt?: string;
    didntGoLive?: boolean;
    startsAt: string;
    durationMin: number;
  },
>(w: T, now: number): T {
  if (w.status === "ended" || w.status === "live" || w.status === "draft") return w;
  if (!lapsedWithoutLive(w, now)) return w;
  return { ...w, status: "ended", didntGoLive: true };
}
