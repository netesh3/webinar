/* Scheduling a simulive from a recording: which recordings can be one, and what the schedule
 * form starts with when a host picks one ("▶ Replay as Simulive").
 *
 * The server holds the same rule (host.go simuliveRecordingField, store HostReadyRecordings):
 * the host's own recording, ready, with bytes stored. A recording still recording, uploading
 * or failed has nothing to play yet, so it is not offered. Pure, so it is tested on its own
 * (simulive-create.test.mts). */

import type { Recording, Webinar } from "./api-types.ts";

/** The longest session the server takes (maxDurationMin in host.go). */
const MAX_DURATION_MIN = 24 * 60;

/** Whether a recording can be played as a simulive: finished, and its file stored. */
export function simuliveEligible(rec: Pick<Recording, "status" | "sizeBytes">): boolean {
  return rec.status === "ready" && rec.sizeBytes > 0;
}

/** The ones a "Change recording" picker lists, newest first, as the library returns them. */
export function eligibleRecordings<R extends Pick<Recording, "status" | "sizeBytes">>(
  list: readonly R[],
): R[] {
  return list.filter(simuliveEligible);
}

/** A simulive runs exactly as long as its recording: whole minutes, rounded up so the end
 *  is never cut off, at least one, at most the server's ceiling. */
export function simuliveDurationMin(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.min(MAX_DURATION_MIN, Math.max(1, Math.ceil(durationMs / 60_000)));
}

/** Where "▶ Replay as Simulive" goes: the schedule form, told which recording. */
export function simuliveScheduleHref(rec: Pick<Recording, "id">): string {
  return `/host/new?simulive=${encodeURIComponent(rec.id)}`;
}

/** The fields the schedule form takes from a recording (and, when it could be read, the
 *  webinar it was recorded in). Everything else stays as a new webinar's defaults. */
export type SimulivePrefill = {
  kind: "simulive";
  simuliveRecordingId: string;
  topic: string;
  summary: string;
  description: string;
  track: string;
  durationMin: number;
  /** A simulive stays in this app, on standard delivery (the server refuses Zoom and edge). */
  venue: "app";
  delivery: "standard";
};

export function simulivePrefill(
  rec: Pick<Recording, "id" | "topic" | "durationMs">,
  source?: Pick<Webinar, "topic" | "summary" | "description" | "track"> | null,
): SimulivePrefill {
  return {
    kind: "simulive",
    simuliveRecordingId: rec.id,
    topic: (source?.topic || rec.topic || "").trim(),
    summary: source?.summary ?? "",
    description: source?.description ?? "",
    track: source?.track ?? "",
    durationMin: simuliveDurationMin(rec.durationMs),
    venue: "app",
    delivery: "standard",
  };
}

/** Picking another recording in the form: its length always follows, and the title follows
 *  only while it is still the previous recording's own (a title the host typed is kept). */
export function switchRecording(
  current: { topic: string },
  from: Pick<Recording, "topic"> | null,
  to: Pick<Recording, "id" | "topic" | "durationMs">,
): { simuliveRecordingId: string; durationMin: number; topic: string } {
  const untouched =
    current.topic.trim() === "" || (from != null && current.topic.trim() === from.topic.trim());
  return {
    simuliveRecordingId: to.id,
    durationMin: simuliveDurationMin(to.durationMs),
    topic: untouched ? to.topic.trim() : current.topic,
  };
}

/* ---- how a simulive starts (WebinarOptions.simuliveStart / simuliveDoorsOpenMin; the server's
 * rules are api/internal/api/simulive_live.go). */

/** A simulive may start a minute out (minSimuliveLead in host.go); anything else as given. */
export const SIMULIVE_LEAD_MS = 60_000;

export function scheduleLeadMs(kind: string, otherwise: number): number {
  return kind === "simulive" ? SIMULIVE_LEAD_MS : otherwise;
}

/** The quick "start in N minutes" choices, and the doors-open ones (minutes before). */
export const START_IN_MINUTES = [5, 10, 15, 30] as const;
export const DOORS_OPEN_MINUTES = [0, 5, 10, 15, 30] as const;
/** What a simulive with no choice stored opens its doors at (DefaultSimuliveDoorsOpenMin). */
export const DEFAULT_DOORS_OPEN_MIN = 10;

export type SimuliveStartMode = "auto" | "manual";

/** The stored mode as the form shows it: anything but "manual" is automatic. */
export function startMode(options: { simuliveStart?: string } | null | undefined): SimuliveStartMode {
  return options?.simuliveStart === "manual" ? "manual" : "auto";
}

export function doorsOpenMin(options: { simuliveDoorsOpenMin?: number } | null | undefined): number {
  const d = options?.simuliveDoorsOpenMin;
  return typeof d === "number" && d >= 0 ? d : DEFAULT_DOORS_OPEN_MIN;
}

/** The start for "start in N minutes": now + N, rounded UP to the minute (the form's time
 *  field has no seconds), as the date and time inputs show it in the form's zone. */
export function startInMinutes(nowMs: number, minutes: number, timeZone: string): { date: string; time: string } {
  const at = Math.ceil((nowMs + minutes * 60_000) / 60_000) * 60_000;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(at));
  const v = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = v("hour") === "24" ? "00" : v("hour");
  return { date: `${v("year")}-${v("month")}-${v("day")}`, time: `${hour}:${v("minute")}` };
}
