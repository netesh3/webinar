/* The recording preview on the simulive schedule form and its recording picker: the pure
 * half. Which chapters the player shows, from the recap of the session the recording was
 * made in, and what the chapter list says when there are none. The component
 * (components/recording-preview.tsx) is the fetching and the markup around this. */

import type { Recording, SessionRecapResponse } from "./api-types.ts";
import { chapterSeekTimes, type PlayerChapter } from "./recap.ts";
import { playableRecordingParts } from "./recording-parts.ts";

export type PreviewChapters = {
  chapters: PlayerChapter[];
  /** The recap is still being written: chapters may yet arrive. */
  pending: boolean;
  /** What the chapter list says instead of chapters; null when there are some. */
  empty: string | null;
};

/* recap is null when it could not be read (no recap, not allowed, offline): that is no
 * chapters, said the same way as a session that simply has none. */
export function previewChapters(
  recap: SessionRecapResponse | null,
  sessionStartedAt: string | undefined,
  rec: Pick<Recording, "id" | "status" | "sizeBytes" | "durationMs" | "parts">,
): PreviewChapters {
  const chapters = chapterSeekTimes(
    recap?.recap?.chapters ?? [],
    sessionStartedAt,
    playableRecordingParts(rec),
  );
  const pending = recap?.status === "pending";
  if (chapters.length > 0) return { chapters, pending, empty: null };
  return {
    chapters,
    pending,
    empty: pending ? "No chapters yet. The AI recap is still being written." : "No chapters yet",
  };
}
