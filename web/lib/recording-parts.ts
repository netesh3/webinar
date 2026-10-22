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

/* The player's playlist. captionsFor, when the session has captions, is each take's own
 * captions file: the player swaps the file at each take and the <track> goes with it. One take
 * plays the session's file (no part), so it is the same URL the whole session has. */
export function recordingSources(
  rec: Pick<Recording, "id" | "status" | "sizeBytes" | "durationMs" | "parts"> | PublicRecording,
  urlFor: (id: string) => string,
  captionsFor?: (partId: string | undefined) => string,
): { src: string; durationMs: number; captions?: string }[] {
  const parts = playableRecordingParts(rec);
  return parts.map((p) => ({
    src: urlFor(p.id),
    durationMs: p.durationMs,
    ...(captionsFor ? { captions: captionsFor(parts.length > 1 ? p.id : undefined) } : {}),
  }));
}
