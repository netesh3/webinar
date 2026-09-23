"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Recording } from "@/lib/api-types";
import { driveConfigured, pickFromDrive } from "@/lib/drive";
import {
  canShareFile,
  formatPosition,
  looksLikeVideo,
  VIDEO_ACCEPT,
  type FileSource,
} from "@/lib/file-share";
import { formatBytes } from "@/lib/format";
import { isSafari, SCREEN_SHARE_OPTIONS, SHARE_AUDIO_SURFACES } from "@/lib/media";
import type { ScreenShareCaptureOptions } from "livekit-client";
import { Alert, Modal, Spinner } from "../controls";
import { ImageIcon, PlayIcon, RecordIcon, ScreenShareIcon } from "../icons";
import { useAppConfig } from "../providers";
import { useRoomUI } from "./context";

/* "Share a video file".
 *
 * Files only, and that is the whole design.
 *
 * This dialog used to open on a tab row copied from the browser's own picker —
 * Chrome tab · Window · Entire screen · Share by file — and three of those four
 * were a second door onto a room that already has one. Share on the control bar
 * hands straight to the browser's picker, which lists tab, window and screen
 * itself and is the only thing that can: those panes are drawn by the browser,
 * outside the page. All a page can do is ask it to open on one. So the three
 * were dismiss buttons wearing a tablist's clothes — `role="tab"` on controls
 * that closed the dialog instead of swapping a pane, none of which could ever be
 * the selected tab, which is what the screen reader was being told about them.
 *
 * One door, one job now. Sharing a screen is Share; sharing a recorded video is
 * here. The link at the foot is the single concession — somebody who opened this
 * meaning the other thing should not have to go hunting for Share again — and it
 * is shaped like a link because a link is what it is.
 */

type Surface = "browser" | "window" | "monitor";

type Step =
  | { at: "source" }
  | { at: "preview"; source: FileSource }
  | { at: "loading"; label: string; progress: number | null };

export function SharePicker({
  open,
  onClose,
  onScreenShare,
}: {
  open: boolean;
  onClose: () => void;
  /** Runs getDisplayMedia with a surface hint. Owned by the control bar, which
   *  already has the error handling and the busy state for it. Used here only by
   *  the way out at the foot of the dialog. */
  onScreenShare: (surface: Surface) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      dark
      size="lg"
      // Says which of the two kinds of sharing this is, because the title is the
      // only thing that can — "Choose what to share" was written when the tab row
      // meant it really did choose. The audience half of it still needs saying,
      // since it is the whole point of the feature: a recorded video arrives
      // looking like a screen share, not like somebody playing a file at you.
      // Audio is left to the note in the body, which can be specific about it.
      title="Share a video file"
      description="It plays into the webinar as your screen share, full screen. Nobody sees a video player, and there is nothing for them to buffer."
    >
      {/* The steps live in a child, and the child only exists while the dialog is
          open — Modal renders nothing when closed. So closing it discards the
          progress through the flow for free, rather than through an effect that
          resets four pieces of state on the way back in. That matters more than
          tidiness: a dialog reopening on the preview of a file the host abandoned
          last time is a dialog that shares the wrong video. */}
      <ShareSteps onClose={onClose} onScreenShare={onScreenShare} />
    </Modal>
  );
}

function ShareSteps({
  onClose,
  onScreenShare,
}: {
  onClose: () => void;
  onScreenShare: (surface: Surface) => void;
}) {
  const { fileShare } = useRoomUI();
  const [step, setStep] = useState<Step>({ at: "source" });
  const [error, setError] = useState<string | null>(null);

  const supported = canShareFile();

  const share = useCallback(
    async (source: FileSource, startAt: number) => {
      setStep({ at: "loading", label: "Starting the share…", progress: null });
      setError(null);
      await fileShare.start(source, startAt);
      onClose();
    },
    [fileShare, onClose],
  );

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      {fileShare.error && step.at === "source" && (
        <Alert tone="error">{fileShare.error}</Alert>
      )}

      {step.at === "source" && (
        <>
          {/* The note that stood here said the opposite — "use Chrome tab and tick
              Also share tab audio" — and it was right for as long as this dialog
              was also the screen-share dialog. For a file it is backwards. A shared
              file's soundtrack is pulled off the element through an AudioContext and
              published as its own ScreenShareAudio track (lib/file-share.ts), so it
              travels on every platform with nothing to tick. The macOS trap the old
              note existed to warn about is one this path simply does not have, and
              that is worth saying here: it is the reason to play a video through
              this dialog rather than by sharing the tab it is playing in. */}
          <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-2">
            <strong className="font-medium text-ink">Sound travels with it.</strong>{" "}
            {SHARE_AUDIO_SURFACES.systemAudio
              ? "The video's own audio is published alongside the picture — nothing to tick in a browser dialog, and no silent share to discover halfway through."
              : "The video's own audio is published alongside the picture — including on macOS, where sharing a window or your whole screen cannot carry sound at all."}
          </p>

          {supported ? (
            <SourceStep
              onChosen={(source) => setStep({ at: "preview", source })}
              onBusy={(label, progress) => setStep({ at: "loading", label, progress })}
              onError={(message) => {
                setError(message);
                setStep({ at: "source" });
              }}
            />
          ) : (
            /* Defensive: the button that opens this is already gated on
               canShareFile() in control-bar.tsx, so nobody should arrive here. If
               they do, say why rather than showing a list of files that cannot be
               played — and leave the way out below reachable, because sharing a
               screen still works in a browser that cannot capture an element. */
            <Alert tone="warn">
              This browser can&apos;t play a file into a webinar — it has no way to
              capture a video element. Chrome, Edge and Firefox can. Safari cannot.
            </Alert>
          )}

          <ShareScreenInstead
            onClick={() => {
              onScreenShare("browser");
              onClose();
            }}
          />
        </>
      )}

      {step.at === "preview" && (
        <PreviewStep
          source={step.source}
          onBack={() => {
            step.source.release?.();
            setStep({ at: "source" });
          }}
          onShare={(startAt) => void share(step.source, startAt)}
        />
      )}

      {step.at === "loading" && (
        <div className="flex flex-col items-center gap-3 py-10">
          <Spinner className="size-6 text-ink-3" />
          <p className="text-[13px] text-ink-2">{step.label}</p>
          {step.progress !== null && (
            <div className="h-1.5 w-56 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-brand transition-[width]"
                style={{ width: `${Math.round(step.progress * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The way out, for somebody who wanted the other kind of sharing.
 *
 *  Only on the first step. Once a file is chosen the host is on the preview with
 *  its own way back, and a live-share link there would be a click that throws the
 *  file away — the same reason it is a quiet line under a rule rather than
 *  anything that competes with "Share this video".
 *
 *  It hands off with the "browser" hint, which is what Share on the control bar
 *  does too: the browser opens its picker on the tab pane and the host can move
 *  to window or whole screen inside it. Offering all three here would be this
 *  dialog pretending to make a choice it does not get to make. */
function ShareScreenInstead({ onClick }: { onClick: () => void }) {
  return (
    <div className="border-t border-line-2 pt-3.5">
      <p className="text-[11.5px] text-ink-3">
        Meant to share your screen or a tab instead?
      </p>
      <button
        type="button"
        onClick={onClick}
        className="mt-0.5 inline-flex items-center gap-1.5 rounded text-[12.5px] font-medium text-brand transition-colors hover:text-brand/80 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <ScreenShareIcon className="size-3.5" />
        Share your screen instead
        <span aria-hidden>→</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the sources

function SourceStep({
  onChosen,
  onBusy,
  onError,
}: {
  onChosen: (source: FileSource) => void;
  onBusy: (label: string, progress: number | null) => void;
  onError: (message: string) => void;
}) {
  const { slug } = useRoomUI();
  const { googleClientId, googleApiKey } = useAppConfig();
  const drive = { clientId: googleClientId ?? "", apiKey: googleApiKey ?? "" };
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const [recordings, setRecordings] = useState<Recording[] | null>(null);

  // This webinar's own recordings. Listed first, because "a previously recorded
  // webinar" is the thing this feature is for and they are already on the server —
  // nothing to upload and nothing to hold in memory, since the file endpoint
  // supports range requests and the element streams it.
  useEffect(() => {
    let cancelled = false;
    api
      .recordings(slug)
      .then((list) => {
        if (!cancelled) setRecordings(list.filter((r) => r.status === "ready"));
      })
      .catch(() => {
        if (!cancelled) setRecordings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const fromDrive = async () => {
    if (!driveConfigured(drive)) return;
    const controller = new AbortController();
    abort.current = controller;
    onBusy("Waiting for Google…", null);
    try {
      const picked = await pickFromDrive(
        drive,
        (fraction) => onBusy("Copying from Drive…", fraction),
        controller.signal,
      );
      if (!picked) {
        // Backed out. Return to the source list rather than reporting an error.
        onError("");
        return;
      }
      onChosen({
        kind: "drive",
        name: picked.name,
        url: picked.url,
        size: picked.size,
        release: () => URL.revokeObjectURL(picked.url),
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't get that file from Drive.");
    }
  };

  return (
    <div className="space-y-4">
      {/* ---- this webinar's recordings ---- */}
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          Recorded on this webinar
        </h3>
        {recordings === null ? (
          <div className="flex items-center gap-2 rounded-lg border border-line-2 px-3.5 py-3 text-[12.5px] text-ink-3">
            <Spinner className="size-4" />
            Looking for recordings…
          </div>
        ) : recordings.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-2 px-3.5 py-3 text-[12.5px] text-ink-3">
            Nothing recorded here yet. Pick a file from your computer instead.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {recordings.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() =>
                    onChosen({
                      kind: "recording",
                      name: `${r.topic} · ${new Date(r.createdAt).toLocaleString()}`,
                      // Streamed with range requests straight off our own API, so
                      // nothing is copied into this tab.
                      url: api.recordingFileURL(slug, r.id),
                      size: r.sizeBytes,
                    })
                  }
                  className="flex w-full items-center gap-3 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
                    <RecordIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                    <span className="block text-[11.5px] text-ink-3">
                      {formatPosition(r.durationMs / 1000)} · {formatBytes(r.sizeBytes)} ·{" "}
                      {r.ext.toUpperCase()}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- local disk ---- */}
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          From this computer
        </h3>
        <input
          ref={input}
          type="file"
          accept={VIDEO_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (!looksLikeVideo(file)) {
              onError("That doesn't look like a video. MP4 and WebM work everywhere.");
              return;
            }
            const url = URL.createObjectURL(file);
            onChosen({
              kind: "local",
              name: file.name,
              url,
              size: file.size,
              release: () => URL.revokeObjectURL(url),
            });
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex w-full items-center gap-3 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
            <ImageIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-ink">Choose a video file</span>
            <span className="block text-[11.5px] text-ink-3">
              MP4 or WebM. Played straight from your disk — nothing is uploaded, so
              there is no size limit and no wait.
            </span>
          </span>
        </button>
      </section>

      {/* ---- Google Drive ---- */}
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          Google Drive
        </h3>
        {driveConfigured(drive) ? (
          <button
            type="button"
            onClick={() => void fromDrive()}
            className="flex w-full items-center gap-3 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
              <PlayIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink">Pick from Drive</span>
              <span className="block text-[11.5px] text-ink-3">
                Read-only access to the one file you choose. It is copied into this tab
                first, so give it a moment.
              </span>
            </span>
          </button>
        ) : (
          <p className="rounded-lg border border-dashed border-line-2 px-3.5 py-3 text-[11.5px] text-ink-3">
            Not configured on this instance. An operator needs to set{" "}
            <code className="rounded bg-surface-2 px-1">GOOGLE_CLIENT_ID</code> and{" "}
            <code className="rounded bg-surface-2 px-1">GOOGLE_API_KEY</code>, with the
            Picker API enabled. A file from your computer works either way.
          </p>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- the preview

/** The last look before the room sees it.
 *
 *  A real player, host-only, with the controls the browser gives — and the point
 *  is that whatever position it is left at is where the share begins. Starting at
 *  zero would mean a host who wanted to skip a two-minute intro doing it live, in
 *  front of everyone. */
function PreviewStep({
  source,
  onBack,
  onShare,
}: {
  source: FileSource;
  onBack: () => void;
  onShare: (startAt: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState(0);

  const details = useMemo(() => {
    const parts = [source.kind === "recording" ? "From this webinar" : source.kind === "drive" ? "From Google Drive" : "From this computer"];
    if (source.size > 0) parts.push(formatBytes(source.size));
    return parts.join(" · ");
  }, [source]);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="text-[12px] font-medium text-ink-3 transition-colors hover:text-ink outline-none focus-visible:underline"
      >
        ← Choose a different video
      </button>

      <div className="overflow-hidden rounded-xl border border-line-2 bg-black">
        {/* controls, because this is the host's own preview. The published stream
            is captured from a different element entirely, so nothing here can
            reach the audience. */}
        <video
          ref={video}
          src={source.url}
          controls
          playsInline
          preload="metadata"
          className="aspect-video w-full"
          onLoadedMetadata={(e) => {
            setReady(true);
            setDuration(e.currentTarget.duration);
          }}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onError={() => setFailed(true)}
        />
      </div>

      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{source.name}</p>
        <p className="text-[11.5px] text-ink-3">
          {details}
          {duration > 0 && ` · ${formatPosition(duration)}`}
        </p>
      </div>

      {failed && (
        <Alert tone="error">
          This browser can&apos;t play that file. MP4 with H.264 works everywhere.
        </Alert>
      )}

      <Alert tone="info">
        The webinar will show this as your shared screen, from{" "}
        <strong>{formatPosition(at)}</strong>. Everyone sees the same live position,
        including anyone who joins later. Keep this tab open — playback stops if you
        close it.
      </Alert>

      <button
        type="button"
        disabled={!ready || failed}
        onClick={() => {
          video.current?.pause();
          onShare(at);
        }}
        className="w-full rounded-lg bg-brand px-3.5 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-brand/90 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        Share this video
      </button>
    </div>
  );
}

/** The surface hint, so the control bar and this dialog cannot disagree about what
 *  a screen share is.
 *
 *  `displaySurface` is a hint, not a filter: Chrome opens its own picker on the
 *  matching pane and the host can still switch tabs inside it. That is as close as
 *  a page can get to choosing a tab in a dialog it does not own — and it is why
 *  this dialog can offer the same four choices honestly.
 *
 *  "browser" is the one value in that hint Safari does not recognise — WebKit has
 *  no per-tab capture at all, so there is no pane for it to focus. Reported live:
 *  asking Safari for it did not fail and did not fall back to a normal picker
 *  either — it skipped the interactive chooser entirely and just started sharing
 *  something, which is the platform's own behaviour for a `getDisplayMedia`
 *  constraint it cannot satisfy, not a bug in this dialog. Dropping the hint
 *  outright on Safari — rather than substituting "monitor" or "window" — is what
 *  lets Safari's own native picker (which does list both) come up normally,
 *  which omitting `displaySurface` altogether is documented to do. */
export function displayMediaOptions(surface: Surface): ScreenShareCaptureOptions {
  const video = surface === "browser" && isSafari() ? true : { displaySurface: surface };
  return { ...SCREEN_SHARE_OPTIONS, video };
}
