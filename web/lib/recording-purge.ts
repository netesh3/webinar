/* The admin's "Delete all recordings" (Admin -> Dashboard -> Danger zone), the pure half: when
 * the button may be pressed, whether a run is still going, and what each phase is called. The
 * work is the server's (api/internal/api/recording_purge.go).
 *
 *   node --experimental-strip-types --no-warnings lib/recording-purge.test.mts */
import { PurgeDeleting, PurgeDone, PurgeStopping, PurgeSweeping, RecordingPurgeConfirm } from "./api-types.ts";
import type { RecordingPurge, RecordingPurgeStatus } from "./api-types.ts";

/** Exactly the phrase, as the server checks it: no trimming, no case folding. */
export function purgeConfirmMatches(typed: string): boolean {
  return typed === RecordingPurgeConfirm;
}

/** A run that has started and not finished; the page keeps it going. */
export function purgeRunning(latest: RecordingPurge | undefined | null): boolean {
  return !!latest && latest.phase !== PurgeDone;
}

/** Whether the delete button is live: the phrase typed, nothing in flight on this page, and
 *  either something to delete or a run to carry on. */
export function purgeCanStart(status: RecordingPurgeStatus | null, typed: string, busy: boolean): boolean {
  if (!status || busy || !purgeConfirmMatches(typed)) return false;
  const t = status.totals;
  return purgeRunning(status.latest) || t.recordings + t.clips + t.uploads > 0;
}

export function purgePhaseLabel(phase: string): string {
  switch (phase) {
    case PurgeStopping:
      return "Stopping recordings, clip renders and uploads in progress";
    case PurgeDeleting:
      return "Deleting recordings and their files";
    case PurgeSweeping:
      return "Clearing leftover files from storage";
    case PurgeDone:
      return "Done";
    default:
      return phase;
  }
}
