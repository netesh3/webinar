"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Recording, SessionRecapResponse } from "@/lib/api-types";
import { formatClock } from "@/lib/format";
import { recordingSources } from "@/lib/recording-parts";
import { previewChapters } from "@/lib/recording-preview";
import { Modal, Spinner } from "./controls";
import { RecordingChapters } from "./recording-chapters";
import { VideoPlayer, type VideoPlayerHandle } from "./video-player";

/* A recording played back where a simulive is being set up (the schedule form's "The
 * recording" section and the /host/new/simulive picker): the same player as the host's
 * Recording tab, from the same host-only endpoints, with the session's captions as CC and
 * the AI recap's chapters on the seek bar and listed under it.
 *
 * Mounted only when the host asks to play it, so nothing beyond the thumbnail's metadata is
 * fetched until then; it starts playing at once, since that is what was asked. The chapters
 * come from the recap of the session the recording was made in, placed on the recording by
 * when that session went live (lib/recording-preview.ts). */
export function RecordingPreviewPlayer({ rec, autoPlay = true }: { rec: Recording; autoPlay?: boolean }) {
  const player = useRef<VideoPlayerHandle>(null);
  const [recap, setRecap] = useState<SessionRecapResponse | null>(null);
  const [startedAt, setStartedAt] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    void Promise.all([
      api.sessionRecap(rec.webinar, ctl.signal).catch(() => null),
      api
        .hostWebinar(rec.webinar)
        .then((w) => w.startedAt)
        .catch(() => undefined),
    ]).then(([r, started]) => {
      if (ctl.signal.aborted) return;
      setRecap(r);
      setStartedAt(started);
      setLoaded(true);
    });
    return () => ctl.abort();
  }, [rec.webinar]);

  useEffect(() => {
    if (autoPlay) player.current?.seek(0);
  }, [autoPlay]);

  const { chapters, pending, empty } = previewChapters(recap, startedAt, rec);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <VideoPlayer
        key={rec.id}
        ref={player}
        sources={recordingSources(
          rec,
          (id) => api.recordingFileURL(rec.webinar, id),
          rec.captionsAvailable ? (part) => api.recordingCaptionsURL(rec.webinar, rec.id, part) : undefined,
        )}
        durationMs={rec.durationMs}
        chapters={chapters}
      />
      <p className="flex flex-wrap items-center justify-between gap-2 px-4 pt-2.5 text-[12px] text-ink-3">
        <span className="min-w-0 truncate font-medium text-ink-2">{rec.topic}</span>
        <span className="font-mono tabular-nums">{formatClock(rec.durationMs)}</span>
      </p>
      {!loaded ? (
        <p className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-ink-3">
          <Spinner className="size-3.5" /> Loading chapters…
        </p>
      ) : empty ? (
        <p className="mt-2.5 border-t border-line px-4 py-3 text-[12.5px] text-ink-3">{empty}</p>
      ) : (
        <div className="mt-2.5">
          <RecordingChapters
            chapters={chapters}
            pending={pending}
            onSeek={(sec) => player.current?.seek(sec)}
          />
        </div>
      )}
    </div>
  );
}

/** The same player in a dialog, for a recording in a list. */
export function RecordingPreviewModal({ rec, onClose }: { rec: Recording | null; onClose: () => void }) {
  return (
    <Modal open={rec !== null} onClose={onClose} title={rec?.topic ?? "Recording"} size="xl">
      {rec && <RecordingPreviewPlayer key={rec.id} rec={rec} />}
    </Modal>
  );
}
