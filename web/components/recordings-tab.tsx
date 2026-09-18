"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Recording, Webinar } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { formatBytes, formatClock } from "@/lib/format";
import { ConfirmModal, Spinner } from "./controls";
import { PlayIcon, TrashIcon } from "./icons";
import { useToast } from "./providers";
import { Badge, Button, Card, Empty } from "./ui";

/* Recordings of one webinar.
 *
 * The player is a plain <video> pointed at the download endpoint, which serves
 * range requests — so scrubbing works, and a 40-minute recording does not have to
 * be downloaded before it can be checked. `credentials: include` is implicit for a
 * same-site media element, and the endpoint refuses anyone who is not on this
 * webinar's stage.
 */

export function RecordingsTab({
  webinar: w,
  recordings: rows,
  onChanged,
}: {
  webinar: Webinar;
  /** Loaded by the screen, so the tab strip can show a count without a second
   *  request for the same list. */
  recordings: Recording[];
  onChanged: () => void | Promise<void>;
}) {
  const { notify } = useToast();
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Recording | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Poll while any recording is still processing or recording, so the row
  // transitions to "Ready" without requiring a manual page refresh.
  const hasLive = rows.some((r) => r.status === "recording");
  useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => {
      void onChanged();
    }, 3000);
    return () => clearInterval(timer);
  }, [hasLive, onChanged]);

  async function remove(rec: Recording) {
    setBusy(rec.id);
    try {
      await api.deleteRecording(w.id, rec.id);
      notify("Recording deleted.", "ok");
      if (playing?.id === rec.id) setPlaying(null);
      await onChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not delete that recording.", "error");
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  }

  return (
    <div className="space-y-4">

      {playing && (
        <Card className="overflow-hidden">
          {/* key on the id so switching recordings reloads the element rather than
              seeking the old stream. */}
          <video
            key={playing.id}
            src={api.recordingFileURL(w.id, playing.id)}
            controls
            playsInline
            className="aspect-video w-full bg-black"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
            <p className="text-[12.5px] text-ink-2">
              Recorded by {playing.startedBy || "a presenter"}
            </p>
            <div className="flex gap-2">
              <a
                href={api.recordingFileURL(w.id, playing.id)}
                download
                className="inline-flex h-9 items-center rounded-lg border border-line-2 px-3 text-[13px] font-medium text-ink hover:bg-surface-2"
              >
                Download
              </a>
              <Button variant="ghost" size="sm" onClick={() => setPlaying(null)}>
                Close
              </Button>
            </div>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <Empty
          title="No recordings yet"
          hint="Press Record in the room. The host and any panelist can start one, and only one runs at a time."
        />
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((rec) => (
            <RecordingRow
              key={rec.id}
              recording={rec}
              slug={w.id}
              busy={busy === rec.id}
              onPlay={() => setPlaying(rec)}
              onDelete={() => setConfirmDelete(rec)}
            />
          ))}
        </Card>
      )}

      <p className="text-[12px] leading-relaxed text-ink-3">
        Recordings are stored on this server. Everyone in the room is shown a
        recording indicator while one is running.
      </p>

      <ConfirmModal
        open={confirmDelete !== null}
        busy={busy !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title="Delete this recording?"
        body="The file is removed from the server. This cannot be undone."
        confirmLabel="Delete"
      />
    </div>
  );
}

function RecordingRow({
  recording: rec,
  slug,
  busy,
  onPlay,
  onDelete,
}: {
  recording: Recording;
  slug: string;
  busy: boolean;
  onPlay: () => void;
  onDelete: () => void;
}) {
  // Rendered on the client only: a locale-formatted timestamp differs between the
  // server render and the browser, and React calls that a hydration error.
  const hydrated = useHydrated();
  const live = rec.status === "recording";
  const failed = rec.status === "failed";

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          {live && (
            <Badge tone="live" dot>
              Recording now
            </Badge>
          )}
          {failed && <Badge tone="warn">Incomplete</Badge>}
          {rec.status === "ready" && <Badge tone="ok">Ready</Badge>}
          <span className="text-[11.5px] text-ink-3 uppercase">{rec.ext}</span>
        </div>
        <p className="text-[13.5px] font-medium text-ink">
          {hydrated ? new Date(rec.createdAt).toLocaleString() : rec.createdAt}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {rec.durationMs > 0 ? `${formatClock(rec.durationMs)} · ` : ""}
          {formatBytes(rec.sizeBytes)}
          {rec.startedBy ? ` · started by ${rec.startedBy}` : ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {busy ? (
          <Spinner className="size-4 text-ink-3" />
        ) : (
          <>
            {rec.sizeBytes > 0 && (
              <>
                <Button variant="secondary" size="sm" onClick={onPlay}>
                  <PlayIcon className="size-3.5" />
                  Play
                </Button>
                <a
                  href={api.recordingFileURL(slug, rec.id)}
                  download
                  className="inline-flex h-8 items-center rounded-lg border border-line-2 px-2.5 text-[12.5px] font-medium text-ink hover:bg-surface-2"
                >
                  Download
                </a>
              </>
            )}
            {/* Deleting is the host's alone; a panelist gets a 403 they cannot act
                on, so the button is not offered to them. The server enforces it
                either way. */}
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete this recording"
              title="Delete this recording"
              className="grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-live"
            >
              <TrashIcon className="size-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
