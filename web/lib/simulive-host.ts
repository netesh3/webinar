/* A simulive's life as its room shows it (api/internal/api/simulive_host.go has the rules):
 *
 *   waiting   scheduled — the countdown, chat while the doors are open, and for the host team
 *             the start controls (start now, start in N, delay, cancel, open doors)
 *   playing   the recording, on the shared clock
 *   finished  the recording has reached its end and the server has not yet said what comes
 *             next: nothing plays (no loop, no rewind, no last frame) while it decides
 *   live      the host team stayed: the session carries on live, and every client re-joins
 *             for the ordinary live room
 *   ended     nobody of the host team was there, or the host ended it
 *
 * Pure so node can test it — simulive-host.test.mts, run by `make test-web`. */

/** What the waiting screen counts down to: the start the host set from the room, else the
 *  scheduled start for an automatic simulive, else nothing (a manual one waits for the host). */
export function countdownTarget(
  startsAt: string | null | undefined,
  pendingStartAt: string | null | undefined,
  manual: boolean,
): string | null {
  if (pendingStartAt && !Number.isNaN(Date.parse(pendingStartAt))) return pendingStartAt;
  if (manual) return null;
  return startsAt || null;
}

export type SimuliveView = "waiting" | "playing" | "finished" | "live" | "ended";

/** Which view a simulive's room shows now. */
export function simuliveView(s: {
  status?: string | null;
  startedAt?: string | null;
  lengthMs?: number | null;
  liveAt?: string | null;
  nowMs: number;
}): SimuliveView {
  if (s.status === "ended") return "ended";
  if (s.liveAt) return "live";
  const start = s.startedAt ? Date.parse(s.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return "waiting";
  if (s.lengthMs && s.lengthMs > 0 && s.nowMs - start >= s.lengthMs) return "finished";
  return "playing";
}

/** Milliseconds until the recording's end on the shared clock, or null when there is none
 *  to wait for (not started, length unknown, already past). */
export function msUntilFinished(
  startedAt: string | null | undefined,
  lengthMs: number | null | undefined,
  nowMs: number,
): number | null {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(start) || !lengthMs || lengthMs <= 0) return null;
  const left = start + lengthMs - nowMs;
  return left > 0 ? left : null;
}

/** When the audience may come in, in ms, or null once the doors are open (or the start is
 *  unreadable). Doors-open minutes before the earlier of the scheduled and the pending start. */
export function doorsOpenAtMs(s: {
  startsAt?: string | null;
  pendingStartAt?: string | null;
  doorsOpenMin: number;
  doorsOpen?: boolean;
}): number | null {
  if (s.doorsOpen) return null;
  let start = s.startsAt ? Date.parse(s.startsAt) : Number.NaN;
  const pending = s.pendingStartAt ? Date.parse(s.pendingStartAt) : Number.NaN;
  if (!Number.isNaN(pending) && (Number.isNaN(start) || pending < start)) start = pending;
  if (Number.isNaN(start)) return null;
  return start - Math.max(0, s.doorsOpenMin) * 60_000;
}

export const START_IN_MINUTES = [2, 5, 10] as const;
export const DELAY_MINUTES = 5;

export type HostControls = {
  startNow: boolean;
  startIn: readonly number[];
  /** "Delay 5 min": an automatic simulive, or one with a pending start. */
  delay: boolean;
  /** Cancel the pending start — not when that would start an automatic one this instant. */
  cancel: boolean;
  openDoors: boolean;
  end: boolean;
  /** "End replay early and go live": while the recording plays. At its end the session goes
   *  live by itself with the host team there, so there is nothing to press then. */
  goLive: boolean;
};

const NONE: HostControls = {
  startNow: false,
  startIn: [],
  delay: false,
  cancel: false,
  openDoors: false,
  end: false,
  goLive: false,
};

/** Which of the host bar's controls show in this state. */
export function hostControls(s: {
  view: SimuliveView;
  manual: boolean;
  startsAt?: string | null;
  pendingStartAt?: string | null;
  doorsOpenMin: number;
  doorsOpen?: boolean;
  nowMs: number;
}): HostControls {
  if (s.view === "playing") return { ...NONE, end: true, goLive: true };
  if (s.view === "finished") return { ...NONE, end: true };
  if (s.view !== "waiting") return NONE;
  const pending = Boolean(s.pendingStartAt);
  const startsAt = s.startsAt ? Date.parse(s.startsAt) : Number.NaN;
  const autoPastDue = !s.manual && !Number.isNaN(startsAt) && startsAt <= s.nowMs;
  const opens = doorsOpenAtMs(s);
  return {
    startNow: true,
    startIn: START_IN_MINUTES,
    delay: pending || !s.manual,
    cancel: pending && !autoPastDue,
    openDoors: opens != null && s.nowMs < opens,
    end: false,
    goLive: false,
  };
}

/** How many of the audience are in the room (the host team and hidden helpers aside). */
export function waitingCount(participants: readonly { role: string; identity: string }[] | undefined): number {
  if (!participants) return 0;
  return participants.filter((p) => p.role === "attendee" && p.identity.startsWith("att_")).length;
}

/** "Live with Asha" — the transition between the recording and the live part. */
export function liveWithLabel(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? `Live with ${first}` : "Going live with the host";
}
