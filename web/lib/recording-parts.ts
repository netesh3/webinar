import type { Recording, PublicRecording, RecordingPart } from "./api-types";

/** Takes that are playable, in session order. Stop-then-record-again is one
 *  session with several takes; the player concatenates these. */
export function playableRecordingParts(
  rec: Pick<Recording, "id" | "status" | "sizeBytes" | "durationMs" | "parts"> | PublicRecording,
): RecordingPart[] {
  const parts = rec.parts?.length
    ? rec.parts
    : [
        {
          id: rec.id,
          status: rec.status,
          sizeBytes: rec.sizeBytes,
          durationMs: rec.durationMs,
          createdAt: "",
        },
      ];
  return parts.filter((p) => p.status === "ready" && p.sizeBytes > 0);
}

export function recordingSources(
  rec: Pick<Recording, "id" | "status" | "sizeBytes" | "durationMs" | "parts"> | PublicRecording,
  urlFor: (id: string) => string,
): { src: string; durationMs: number }[] {
  return playableRecordingParts(rec).map((p) => ({
    src: urlFor(p.id),
    durationMs: p.durationMs,
  }));
}
