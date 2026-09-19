"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Recording, Webinar } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { formatBytes, formatClock } from "@/lib/format";
import { ConfirmModal, CopyField, Modal, Spinner, Toggle } from "./controls";
import {
  CloudAlertIcon,
  CloudCheckIcon,
  CloudUploadIcon,
  LockIcon,
  PlayIcon,
  ShareIcon,
  TrashIcon,
} from "./icons";
import { useToast } from "./providers";
import { Badge, Button, Card, Empty } from "./ui";
import { VideoPlayer } from "./video-player";

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
  const [sharing, setSharing] = useState<Recording | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Recording | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Poll while any recording is still processing or recording,
  // so the row transitions to "Ready" without requiring a manual page refresh.
  const hasLive = rows.some(
    (r) => r.status === "recording" || r.status === "processing",
  );
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
      if (sharing?.id === rec.id) setSharing(null);
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
          <VideoPlayer
            key={playing.id}
            src={api.recordingFileURL(w.id, playing.id)}
            durationMs={playing.durationMs}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
            <p className="text-[12.5px] text-ink-2">
              Recorded by {playing.startedBy || "a presenter"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSharing(playing)}
              >
                <ShareIcon className="size-3.5" />
                Share
              </Button>
              <a
                href={`${api.recordingFileURL(w.id, playing.id)}?download=1`}
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
              onShare={() => setSharing(rec)}
              onDelete={() => setConfirmDelete(rec)}
            />
          ))}
        </Card>
      )}

      <p className="text-[12px] leading-relaxed text-ink-3">
        Recordings are securely stored in cloud storage (S3) and served directly via CDN edge. Everyone in the room is shown a
        recording indicator while one is running.
      </p>

      {sharing && (
        <ShareRecordingModal
          open={sharing !== null}
          webinar={w}
          recording={sharing}
          onClose={() => setSharing(null)}
          onSaved={async () => {
            await onChanged();
            setSharing(null);
          }}
        />
      )}

      <ConfirmModal
        open={confirmDelete !== null}
        busy={busy !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title="Delete this recording?"
        body="The file is removed from cloud storage. This cannot be undone."
        confirmLabel="Delete"
      />
    </div>
  );
}

function ShareRecordingModal({
  open,
  webinar: w,
  recording: rec,
  onClose,
  onSaved,
}: {
  open: boolean;
  webinar: Webinar;
  recording: Recording;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const hydrated = useHydrated();
  const [isPublic, setIsPublic] = useState(rec.isPublic);
  const [passcode, setPasscode] = useState(rec.passcode ?? "");
  const [busy, setBusy] = useState(false);

  const shareUrl = hydrated
    ? `${window.location.origin}/w/${w.id}/recording/${rec.id}`
    : `https://webinarliv.com/w/${w.id}/recording/${rec.id}`;

  async function handleSave() {
    setBusy(true);
    try {
      await api.updateRecordingShare(w.id, rec.id, {
        isPublic,
        passcode,
      });
      notify("Share settings updated.", "ok");
      await onSaved();
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "Failed to update share settings.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share Recording"
      description="Anyone with this link can watch or download the recording."
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy}>
            {busy ? <Spinner className="size-4" /> : "Save Settings"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 py-1">
        <CopyField value={shareUrl} label="Public share link" />

        {rec.status === "processing" && (
          <div className="rounded-lg border border-warn/30 bg-warn-soft/30 p-2.5 text-[12px] text-ink-2 space-y-1.5">
            <div className="flex items-center justify-between font-semibold text-ink">
              <span>Upload in progress:</span>
              <span className="font-mono text-brand">{rec.uploadPercent || 0}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full bg-brand transition-all duration-300"
                style={{ width: `${rec.uploadPercent || 0}%` }}
              />
            </div>
            <p className="text-[11.5px] text-ink-3">
              This recording is uploading to secure cloud storage. Viewers will be able to play it as soon as processing completes.
            </p>
          </div>
        )}

        <div className="pt-2 border-t border-line space-y-4">
          <Toggle
            checked={isPublic}
            onChange={setIsPublic}
            label="Enable public viewing"
            description="When enabled, anyone with the link can view this recording."
          />

          <div className="space-y-1.5">
            <label className="block text-[12.5px] font-medium text-ink">
              Passcode protection (optional)
            </label>
            <input
              type="text"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder={
                w.passcodeRequired ? "Leave blank to use webinar passcode" : "No passcode"
              }
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-3 outline-none focus:border-brand"
            />
            <p className="text-[11.5px] text-ink-3">
              {passcode.trim() !== ""
                ? "Viewers must enter this custom passcode before watching."
                : w.passcodeRequired
                  ? "Viewers must enter the webinar's passcode to watch."
                  : "No passcode required. Anyone with the link can watch."}
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RecordingRow({
  recording: rec,
  slug,
  busy,
  onPlay,
  onShare,
  onDelete,
}: {
  recording: Recording;
  slug: string;
  busy: boolean;
  onPlay: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  // Rendered on the client only: a locale-formatted timestamp differs between the
  // server render and the browser, and React calls that a hydration error.
  const hydrated = useHydrated();
  const live = rec.status === "recording";
  const processing = rec.status === "processing";
  const ready = rec.status === "ready";
  const failed = rec.status === "failed";
  const pct = rec.uploadPercent ?? 0;

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          {live && (
            <Badge tone="live" dot>
              Recording now
            </Badge>
          )}
          {processing && (
            <Badge tone="warn">
              <span className="inline-flex items-center gap-1">
                <CloudUploadIcon className="size-3 animate-pulse" />
                Uploading to S3 {pct > 0 ? `(${pct}%)` : "..."}
              </span>
            </Badge>
          )}
          {failed && (
            <Badge tone="warn">
              <span className="inline-flex items-center gap-1">
                <CloudAlertIcon className="size-3" />
                Upload Failed
              </span>
            </Badge>
          )}
          {ready && (
            <>
              <Badge tone="ok">
                <span className="inline-flex items-center gap-1">
                  <CloudCheckIcon className="size-3" />
                  Ready
                </span>
              </Badge>
              {!rec.isPublic ? (
                <Badge tone="warn">Private</Badge>
              ) : rec.passcodeRequired ? (
                <Badge tone="neutral">
                  <span className="inline-flex items-center gap-1">
                    <LockIcon className="size-3" />
                    Passcode
                  </span>
                </Badge>
              ) : null}
            </>
          )}
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
        {processing && pct > 0 && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-brand transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono text-[11px] text-ink-3">{pct}%</span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {busy ? (
          <Spinner className="size-4 text-ink-3" />
        ) : (
          <>
            {ready && rec.sizeBytes > 0 && (
              <>
                <Button variant="secondary" size="sm" onClick={onPlay}>
                  <PlayIcon className="size-3.5" />
                  Play
                </Button>
                <Button variant="secondary" size="sm" onClick={onShare}>
                  <ShareIcon className="size-3.5" />
                  Share
                </Button>
                <a
                  href={`${api.recordingFileURL(slug, rec.id)}?download=1`}
                  download
                  className="inline-flex h-8 items-center rounded-lg border border-line-2 px-2.5 text-[12.5px] font-medium text-ink hover:bg-surface-2"
                >
                  Download
                </a>
              </>
            )}
            {processing && (
              <>
                <Button variant="secondary" size="sm" disabled title={`Uploading to S3 (${pct}%)...`}>
                  <Spinner className="size-3" />
                  {pct > 0 ? `Uploading ${pct}%` : "Uploading..."}
                </Button>
                <Button variant="secondary" size="sm" onClick={onShare}>
                  <ShareIcon className="size-3.5" />
                  Share
                </Button>
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
