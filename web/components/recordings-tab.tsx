"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { FeatureReplayLinks } from "@/lib/api-types";
import type { Recording, Webinar } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { formatBytes, formatClock } from "@/lib/format";
import { ConfirmModal, CopyField, Modal, Spinner, Toggle, Alert } from "./controls";
import { useAppConfig, useSession, useToast } from "./providers";
import {
  daysUntilExpiry,
  recordingRetentionDays,
  retentionNotice,
} from "@/lib/recording-retention";
import {
  CloudAlertIcon,
  CloudCheckIcon,
  CloudUploadIcon,
  LockIcon,
  PlayIcon,
  ShareIcon,
  TrashIcon,
  YouTubeIcon,
} from "./icons";
import { Badge, Button, Card, Empty } from "./ui";
import { VideoPlayer } from "./video-player";
import { recordingSources } from "@/lib/recording-parts";

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
  const cfg = useAppConfig();
  const days = recordingRetentionDays(rows[0], cfg.recordingsRetentionDays);
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [sharing, setSharing] = useState<Recording | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Recording | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Poll while any recording is still processing or recording, so the row
  // transitions to "Ready" without requiring a manual page refresh. A ready row
  // with no size yet is still in flight for the reason RecordingRow explains,
  // and is what the server reconciles in the background — so keep asking.
  const hasLive = rows.some(
    (r) =>
      r.status === "recording" ||
      r.status === "processing" ||
      (r.status === "ready" && r.sizeBytes <= 0),
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
      {days > 0 && (
        <Alert tone="warn" title={`Stored for ${days} days`}>
          {retentionNotice(days)}
        </Alert>
      )}

      {w.streamWatchUrl && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-ink">
                <YouTubeIcon className="size-4" />
                YouTube
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink-2">
                This session was also pushed live to YouTube. The processed video
                usually appears a few minutes after you end the live.
              </p>
            </div>
            <a
              href={w.streamWatchUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 shrink-0 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-white"
            >
              Open on YouTube
            </a>
          </div>
          <CopyField value={w.streamWatchUrl} label="Watch link" />
        </Card>
      )}

      {playing && (
        <Card className="overflow-hidden">
          <VideoPlayer
            key={playing.id}
            sources={recordingSources(playing, (id) => api.recordingFileURL(w.id, id))}
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
                Download to this computer
              </a>
              <Button variant="ghost" size="sm" onClick={() => setPlaying(null)}>
                Close
              </Button>
            </div>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        !w.streamWatchUrl && (
          <Empty
            title="No recordings yet"
            hint="Press Record in the room, or stream to YouTube from the control bar. Stop and start again adds to the same recording — one file per webinar."
          />
        )
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((rec) => (
            <RecordingCard
              key={rec.id}
              recording={rec}
              slug={w.id}
              busy={busy === rec.id}
              playing={playing?.id === rec.id}
              onPlay={() => setPlaying(rec)}
              onShare={() => setSharing(rec)}
              onDelete={() => setConfirmDelete(rec)}
            />
          ))}
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-ink-3">
        {days > 0
          ? `Cloud recordings are deleted after ${days} days. Download one to keep it on your computer. Everyone in the room is shown a recording indicator while a cloud recording is running.`
          : "Recordings are stored in cloud storage and served from the CDN. Everyone in the room is shown a recording indicator while one is running."}
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
  const { account } = useSession();
  const hydrated = useHydrated();
  /* Whether publishing will tell anybody. The same switch the server checks —
   * an account without it publishes a recording and nothing is sent, which is
   * how this worked before the replay existed. */
  const tellsRegistrants = (account?.features ?? []).includes(
    FeatureReplayLinks,
  );
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
      description={
        recordingRetentionDays(rec) > 0
          ? `Anyone with this link can watch or download. The cloud copy is deleted after ${recordingRetentionDays(rec)} days — download it to keep it on your computer.`
          : "Anyone with this link can watch or download the recording."
      }
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

          {/* Said before Save, not afterwards. Publishing is what sends the
              replay to everybody who registered, and a host who did not expect
              that has already sent it by the time a toast could tell them.
              Only while it is still private: once it is published the messages
              have gone, and switching it off and on again sends nothing, so
              repeating the warning would misdescribe what the button does. */}
          {tellsRegistrants && isPublic && !rec.isPublic && (
            <Alert tone="info">
              Saving this emails everyone who registered — and messages the ones
              who opted in on WhatsApp — with a link to watch it back. It happens
              once per person: unpublishing and publishing again sends nothing.
            </Alert>
          )}

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

/* The thumbnail.
 *
 * A muted <video preload="metadata"> pointed at the first frame, rather than a
 * poster image: there is nowhere to put a generated one. The API stores the
 * container it was given and nothing else, and drawing a frame to a canvas in
 * the browser would taint it — the file is served by a redirect to object
 * storage, which is a different origin. Asking the browser for metadata and the
 * frame at #t is the same picture with none of that.
 *
 * The media fragment is a second in rather than zero: the opening frame of a
 * composited room is usually a black canvas the encoder emitted before the
 * first participant painted. */
function RecordingThumb({
  src,
  durationMs,
  parts,
}: {
  src: string;
  durationMs: number;
  parts: number;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative aspect-video w-full overflow-hidden bg-stage">
      {failed ? (
        <div className="grid size-full place-items-center bg-gradient-to-br from-surface-2 to-surface-3">
          <PlayIcon className="size-8 text-ink-3" />
        </div>
      ) : (
        <video
          src={`${src}#t=1`}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          aria-hidden
          onError={() => setFailed(true)}
          className="pointer-events-none size-full object-cover"
        />
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />

      <div className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
        <span className="grid size-12 place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm">
          <PlayIcon className="size-5 translate-x-0.5" />
        </span>
      </div>

      <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
        {parts > 1 && (
          <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10.5px] font-medium text-white">
            {parts} takes
          </span>
        )}
        {durationMs > 0 && (
          <span className="rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10.5px] text-white tabular-nums">
            {formatClock(durationMs)}
          </span>
        )}
      </div>
    </div>
  );
}

function RecordingCard({
  recording: rec,
  slug,
  busy,
  playing,
  onPlay,
  onShare,
  onDelete,
}: {
  recording: Recording;
  slug: string;
  busy: boolean;
  playing: boolean;
  onPlay: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  // Rendered on the client only: a locale-formatted timestamp differs between the
  // server render and the browser, and React calls that a hydration error.
  const hydrated = useHydrated();
  const live = rec.status === "recording";
  // A cloud recording whose size is still zero has not landed in storage yet,
  // whatever the row says — an Egress uploads its file after the room closes,
  // so "ready" can arrive before the bytes do. Showing it as ready is what left
  // a row reading "Ready · 0 MB" with nothing behind the Play button.
  const awaitingBytes = rec.sizeBytes <= 0;
  const processing = rec.status === "processing" || (rec.status === "ready" && awaitingBytes);
  const ready = rec.status === "ready" && !awaitingBytes;
  const failed = rec.status === "failed";
  const pct = rec.uploadPercent ?? 0;
  const until = daysUntilExpiry(rec.expiresAt);
  const soon = until !== null && until <= 7;
  const firstPlayable =
    rec.parts?.find((p) => p.status === "ready" && p.sizeBytes > 0)?.id ?? rec.id;

  return (
    <Card
      className={`overflow-hidden transition-shadow ${playing ? "ring-2 ring-brand" : ""}`}
    >
      {ready ? (
        <button
          type="button"
          onClick={onPlay}
          aria-label="Play this recording"
          className="group block w-full outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <RecordingThumb
            src={api.recordingFileURL(slug, firstPlayable)}
            durationMs={rec.durationMs}
            parts={rec.parts?.length ?? 1}
          />
        </button>
      ) : (
        <div className="grid aspect-video w-full place-items-center bg-surface-2 text-center">
          <div className="px-4">
            {live ? (
              <>
                <span className="mx-auto mb-2 block size-2.5 animate-pulse rounded-full bg-live" />
                <p className="text-[13px] font-medium text-ink">Recording now</p>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  It appears here when the room closes.
                </p>
              </>
            ) : processing ? (
              <>
                <CloudUploadIcon className="mx-auto mb-2 size-6 animate-pulse text-ink-3" />
                <p className="text-[13px] font-medium text-ink">
                  {pct > 0 ? `Uploading ${pct}%` : "Finishing upload"}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  The player appears as soon as the file lands.
                </p>
              </>
            ) : (
              <>
                <CloudAlertIcon className="mx-auto mb-2 size-6 text-ink-3" />
                <p className="text-[13px] font-medium text-ink">No file was produced</p>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  This take failed before anything was stored.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      <div className="p-4">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
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
          {failed && <Badge tone="warn">Failed</Badge>}
          <span className="text-[11.5px] text-ink-3 uppercase">{rec.ext}</span>
        </div>

        <p className="truncate text-[13.5px] font-medium text-ink">
          {hydrated ? new Date(rec.createdAt).toLocaleString() : rec.createdAt}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {rec.sizeBytes > 0 ? formatBytes(rec.sizeBytes) : "Size pending"}
          {rec.startedBy ? ` · started by ${rec.startedBy}` : ""}
        </p>

        {ready && rec.expiresAt && (
          <p className={`mt-1.5 text-[12px] ${soon ? "font-medium text-warn" : "text-ink-3"}`}>
            {until !== null && until <= 0
              ? "Deletes today — download a copy to keep it."
              : until !== null && until === 1
                ? "Deletes tomorrow. Download a copy to keep it."
                : until !== null && until <= 7
                  ? `Deletes in ${until} days. Download a copy to keep it.`
                  : `Kept until ${hydrated ? new Date(rec.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" }) : rec.expiresAt}.`}
          </p>
        )}

        {processing && pct > 0 && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full bg-brand transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          {busy ? (
            <Spinner className="size-4 text-ink-3" />
          ) : (
            <>
              {ready && (
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
                    title="Download to this computer"
                    className="inline-flex h-8 items-center rounded-lg border border-line-2 px-2.5 text-[12.5px] font-medium text-ink hover:bg-surface-2"
                  >
                    Download
                  </a>
                </>
              )}
              {processing && (
                <Button variant="secondary" size="sm" disabled>
                  <Spinner className="size-3" />
                  {pct > 0 ? `Uploading ${pct}%` : "Uploading"}
                </Button>
              )}
              {/* Deleting is the host's alone; a panelist gets a 403 they cannot act
                  on, so the button is not offered to them. The server enforces it
                  either way. */}
              <button
                type="button"
                onClick={onDelete}
                aria-label="Delete this recording"
                title="Delete this recording"
                className="ml-auto grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-live"
              >
                <TrashIcon className="size-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
