"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { FeatureWhatsAppCRM } from "@/lib/api-types";
import type { RecapChapter, Recording, Webinar } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { formatBytes, formatClock } from "@/lib/format";
import { ConfirmModal, CopyField, Modal, Spinner, Toggle, Alert } from "./controls";
import { useAppConfig, useSession, useToast } from "./providers";
import {
  daysLeftText,
  daysUntilExpiry,
  recordingRetentionDays,
  retentionNotice,
} from "@/lib/recording-retention";
import { ApiError } from "@/lib/http";
import { RecordingStorageMeter, useRecordingStorage } from "./recording-storage-meter";
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
import { Badge, Button, ButtonLink, Card, Empty } from "./ui";
import { VideoPlayer, type VideoPlayerHandle } from "./video-player";
import { RecordingChapters } from "./recording-chapters";
import { playableRecordingParts, recordingSources } from "@/lib/recording-parts";
import { chapterSeekTimes } from "@/lib/recap";
import { clipsOffered, simuliveAllowed } from "@/lib/host-features";
import { RecordingHighlights } from "./recording-highlights";
import { simuliveEligible, simuliveScheduleHref } from "@/lib/simulive-create";
import { SimuliveInfoButton } from "./simulive-info";

/** How often a recap still being written is looked at again, for its chapters. */
const RECAP_POLL_MS = 30_000;

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
  const { account } = useSession();
  /* "Replay as Simulive" is the owner's: the server schedules it from the host's own ready
   * recordings only (host.go simuliveRecordingField), so a panelist or co-host looking at
   * someone else's session is not offered a button that would be refused. A meeting's
   * recording qualifies too — the simulive made from it is a webinar. */
  // And the account's simulive switch (Admin -> Accounts): the server refuses one without it.
  const canSimulive = Boolean(account?.canHost && account.id === w.host.id && simuliveAllowed(account));
  const days = recordingRetentionDays(rows[0], cfg.recordingsRetentionDays);
  /* How long a recording is kept is the owner's (the server refuses anyone else), and so is
   * the storage it counts against. */
  const isOwner = Boolean(account && account.id === w.host.id);
  const { storage, reload: reloadStorage } = useRecordingStorage(isOwner && days > 0);
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [sharing, setSharing] = useState<Recording | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Recording | null>(null);
  const [confirmExpire, setConfirmExpire] = useState<Recording | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const player = useRef<VideoPlayerHandle>(null);

  /* The AI recap's chapters, for the player. Read once the session has ended (that is when
   * a recap exists); a session without one simply has no chapters. The recap waits for the
   * after-session transcript, ten to twenty minutes after the end, which is exactly when a
   * host first plays the recording back: while it is still being written this looks again,
   * so the chapters arrive in a player that is already open rather than after a reload. */
  const [recapChapters, setRecapChapters] = useState<RecapChapter[]>([]);
  const [recapPending, setRecapPending] = useState(false);
  const [recapPoll, setRecapPoll] = useState(0);
  const ended = w.status === "ended";
  useEffect(() => {
    if (!ended) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const res = await api.sessionRecap(w.id, ctl.signal);
        if (ctl.signal.aborted) return;
        setRecapChapters(res.recap?.chapters ?? []);
        const pending = res.status === "pending";
        setRecapPending(pending);
        if (pending) timer = setTimeout(() => setRecapPoll((n) => n + 1), RECAP_POLL_MS);
      } catch {
        // No recap is no chapters.
      }
    }
    void load();
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [ended, w.id, recapPoll]);
  const chapters = playing
    ? chapterSeekTimes(recapChapters, w.startedAt, playableRecordingParts(playing))
    : [];

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
      reloadStorage();
    }
  }

  async function keepLonger(rec: Recording) {
    setBusy(rec.id);
    try {
      const kept = await api.keepRecording(w.id, rec.id);
      notify(
        kept.expiresAt
          ? `Kept until ${new Date(kept.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.`
          : "Kept longer.",
        "ok",
      );
      await onChanged();
    } catch (e) {
      // quota_exceeded carries the whole explanation: what is used, and what to do.
      notify(e instanceof ApiError || e instanceof Error ? e.message : "Could not keep that recording.", "error");
    } finally {
      setBusy(null);
      reloadStorage();
    }
  }

  async function letExpire(rec: Recording) {
    setBusy(rec.id);
    try {
      const after = await api.letRecordingExpire(w.id, rec.id);
      notify(
        after.expiresAt
          ? `It will be deleted on ${new Date(after.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}. No more reminders.`
          : "No more reminders for this recording.",
        "ok",
      );
      await onChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
      setConfirmExpire(null);
    }
  }

  return (
    <div className="space-y-4">
      {days > 0 && (
        <Alert tone="warn" title={`Stored for ${days} days`}>
          {retentionNotice(days)}
        </Alert>
      )}

      {storage && (
        <Card className="p-4">
          <RecordingStorageMeter storage={storage} />
        </Card>
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
            ref={player}
            sources={recordingSources(
              playing,
              (id) => api.recordingFileURL(w.id, id),
              // The session's own captions, previewed whether or not replays show them.
              playing.captionsAvailable
                ? (part) => api.recordingCaptionsURL(w.id, playing.id, part)
                : undefined,
            )}
            durationMs={playing.durationMs}
            chapters={chapters}
          />
          <RecordingChapters
            chapters={chapters}
            pending={recapPending}
            onSeek={(sec) => player.current?.seek(sec)}
          />
          {/* Suggested highlights, for clips: the host's switch, after the end. */}
          {ended && clipsOffered(account) && playing.status === "ready" && (
            <RecordingHighlights
              key={playing.id}
              slug={w.id}
              recording={playing}
              onPreview={(start, end) => player.current?.playRange(start, end)}
            />
          )}
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
              onKeep={isOwner && days > 0 ? () => void keepLonger(rec) : null}
              onLetExpire={isOwner && days > 0 ? () => setConfirmExpire(rec) : null}
              simuliveHref={
                canSimulive && simuliveEligible(rec) ? simuliveScheduleHref(rec) : null
              }
            />
          ))}
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-ink-3">
        {days > 0
          ? `Cloud recordings are deleted ${days} days after they end unless you keep them longer. Download one to keep it on your computer. Everyone in the room is shown a recording indicator while a cloud recording is running.`
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

      <ConfirmModal
        open={confirmExpire !== null}
        busy={busy !== null}
        onClose={() => setConfirmExpire(null)}
        onConfirm={() => confirmExpire && void letExpire(confirmExpire)}
        title="Let this recording expire?"
        body={`It goes back to the standard ${days} days from when it ended${
          confirmExpire?.extended ? " (any extra months are removed)" : ""
        } — never sooner than a day from now — and we stop reminding you. You can still keep it longer until then.`}
        confirmLabel="Let it expire"
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
    FeatureWhatsAppCRM,
  );
  const [isPublic, setIsPublic] = useState(rec.isPublic);
  const [passcode, setPasscode] = useState(rec.passcode ?? "");
  const [showCaptions, setShowCaptions] = useState(rec.showCaptions ?? false);
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
        ...(rec.captionsAvailable && showCaptions !== (rec.showCaptions ?? false) ? { showCaptions } : {}),
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
      // What the link does now, which is the saved setting rather than the switch
      // below: a recording starts private, and until public viewing is switched on
      // and saved, the link shows "Recording Unavailable" to whoever opens it.
      description={`${
        rec.isPublic
          ? "Anyone with this link can watch or download the recording."
          : "Private: nobody can open this link until you turn on public viewing and save."
      }${
        recordingRetentionDays(rec) > 0
          ? ` The cloud copy is deleted after ${recordingRetentionDays(rec)} days — download it to keep it on your computer.`
          : ""
      }`}
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
          {/* The session's own captions as CC on the replay and on any simulive of it. Off
              by default when they were only kept for the AI and never shown live. */}
          {rec.captionsAvailable && (
            <Toggle
              checked={showCaptions}
              onChange={setShowCaptions}
              label="Show captions on replays"
              description="Viewers can turn on this session's captions (CC) on the replay and on simulives of it."
            />
          )}

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
export function RecordingThumb({
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
  onKeep,
  onLetExpire,
  simuliveHref,
}: {
  recording: Recording;
  slug: string;
  busy: boolean;
  playing: boolean;
  onPlay: () => void;
  onShare: () => void;
  onDelete: () => void;
  /** "Keep longer" and "Let it expire": the owner's, null for anyone else. */
  onKeep: (() => void) | null;
  onLetExpire: (() => void) | null;
  /** "Replay as Simulive": the schedule form for this recording, or null when it is not
   *  offered (not ready yet, or not this account's to schedule). */
  simuliveHref: string | null;
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
              {/* Who can open the share link, always said: a recording starts
                  private, so no badge at all would leave "public" to be guessed. */}
              {!rec.isPublic ? (
                <Badge tone="warn">Private</Badge>
              ) : rec.passcodeRequired ? (
                <Badge tone="neutral">
                  <span className="inline-flex items-center gap-1">
                    <LockIcon className="size-3" />
                    Passcode
                  </span>
                </Badge>
              ) : (
                <Badge tone="brand">Public</Badge>
              )}
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
          <div className="mt-1.5 space-y-1.5">
            <p className={`flex flex-wrap items-center gap-1.5 text-[12px] ${soon ? "font-medium text-warn" : "text-ink-3"}`}>
              <span>
                {rec.extended ? "Kept until" : "Deletes"}{" "}
                {hydrated
                  ? new Date(rec.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })
                  : rec.expiresAt.slice(0, 10)}
                {hydrated && until !== null ? ` · ${daysLeftText(until)}` : ""}
              </span>
              {rec.extended && <Badge tone="brand">Kept longer</Badge>}
              {rec.remindersOff && !rec.extended && <Badge tone="neutral">Letting it expire</Badge>}
            </p>
            {onKeep && !busy && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onKeep}
                  disabled={!rec.canExtend}
                  title={
                    rec.canExtend
                      ? "Keep this recording 3 more months from its current date"
                      : rec.overQuota
                        ? "Made while your recording storage was full: kept for the standard period only"
                        : "Your recording storage is full. Delete or let other recordings expire, or upgrade."
                  }
                >
                  Keep 3 more months
                </Button>
                {onLetExpire && (rec.extended || !rec.remindersOff) && (
                  <button
                    type="button"
                    onClick={onLetExpire}
                    className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                  >
                    Let it expire
                  </button>
                )}
              </div>
            )}
          </div>
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
        {ready && simuliveHref && !busy && (
          <div className="mt-2 flex items-center gap-1">
            <ButtonLink
              href={simuliveHref}
              variant="secondary"
              size="sm"
              className="flex-1"
              title="Schedule this recording to play as a live session"
            >
              <PlayIcon className="size-3.5" />
              Replay as Simulive
            </ButtonLink>
            <SimuliveInfoButton />
          </div>
        )}
      </div>
    </Card>
  );
}
