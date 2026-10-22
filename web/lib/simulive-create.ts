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
