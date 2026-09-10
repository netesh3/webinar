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
import { SCREEN_SHARE_OPTIONS, SHARE_AUDIO_SURFACES } from "@/lib/media";
import type { ScreenShareCaptureOptions } from "livekit-client";
import { Alert, Modal, Spinner } from "../controls";
import {
  GridIcon,
  ImageIcon,
  PlayIcon,
  RecordIcon,
  ScreenShareIcon,
  UsersIcon,
} from "../icons";
import { useAppConfig } from "../providers";
import { useRoomUI } from "./context";

/* "Choose what to share".
 *
 * Laid out as a tab row — Chrome tab · Window · Entire screen · Share by file — to
 * match the browser's own picker, because that is the arrangement people already
 * know and "Share by file" belongs at the end of it.
 *
 * The constraint that forced this: the dialog with those tabs is CHROME'S, drawn by
 * the browser outside the page, and a web page cannot add a tab to it. Whether
 * Chrome shows its own "Share by file" pane depends on the Chrome build — it is
 * there in some and absent in others, on the same site. So the four choices live
 * here instead, in the same order, and the first three hand straight off to Chrome
 * pre-focused on the matching pane (`displaySurface` is a real constraint hint).
 * The fourth is ours end to end, and it is the one that needed building.
 */

type Surface = "browser" | "window" | "monitor";

type Step =
  | { at: "choose" }
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
   *  already has the error handling and the busy state for it. */
  onScreenShare: (surface: Surface) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      dark
      size="lg"
      title="Choose what to share"
      description="Everyone in the webinar sees what you pick, full screen."
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
  const [step, setStep] = useState<Step>({ at: "choose" });
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
    <>
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {fileShare.error && step.at === "choose" && (
          <Alert tone="error">{fileShare.error}</Alert>
        )}

        {/* The tab row, in the browser picker's own order. `Share by file` last,
            after `Entire screen`, which is where it sits in Chrome's version. */}
        {(step.at === "choose" || step.at === "source") && (
          <div
            role="tablist"
            aria-label="What to share"
            className="flex items-stretch gap-1 border-b border-line-2 pb-0"
          >
            <SurfaceTab
              label="Chrome tab"
              icon={<GridIcon className="size-4" />}
              onClick={() => {
                onScreenShare("browser");
                onClose();
              }}
            />
            <SurfaceTab
              label="Window"
              icon={<UsersIcon className="size-4" />}
              onClick={() => {
                onScreenShare("window");
                onClose();
              }}
            />
            <SurfaceTab
              label="Entire screen"
              icon={<ScreenShareIcon className="size-4" />}
              onClick={() => {
                onScreenShare("monitor");
                onClose();
              }}
            />
            <SurfaceTab
              label="Share by file"
              icon={<PlayIcon className="size-4" />}
              selected={step.at === "source"}
              disabled={!supported}
              title={supported ? undefined : "This browser can't capture a video file"}
              onClick={() => setStep({ at: "source" })}
            />
          </div>
        )}

        {step.at === "choose" && (
          <div className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center">
            <p className="text-[13px] font-medium text-ink">Pick what to share</p>
            <p className="mx-auto mt-1.5 max-w-xs text-[11.5px] leading-relaxed text-ink-3">
              The first three tabs open your browser&apos;s own picker.{" "}
              <strong className="font-medium text-ink-2">Share by file</strong> plays a
              recorded video into the session as your shared content — the room sees it as
              a live share.
            </p>

            {/* Where the sound goes, said before the choice rather than discovered after it.
                This is the one thing about screen sharing the app cannot fix by trying
                harder: a Mac will not hand a page the audio of a window or a whole screen,
                only of a tab. Somebody sharing their whole desktop to play a video is
                inaudible, and there is no error to tell them so — the share simply works
                and is silent. */}
            <p className="mx-auto mt-3 max-w-xs rounded-lg bg-surface-2 px-3 py-2 text-[11.5px] leading-relaxed text-ink-2">
              <strong className="font-medium text-ink">Playing a video with sound?</strong>{" "}
              Use <strong className="font-medium text-ink">Chrome tab</strong> and tick
              &ldquo;Also share tab audio&rdquo; in the picker.{" "}
              {SHARE_AUDIO_SURFACES.systemAudio
                ? "Window and Entire screen can carry sound too, but a tab is the reliable one."
                : "On macOS a window or the whole screen cannot carry sound at all — only a tab can."}
            </p>
          </div>
        )}

        {step.at === "source" && (
          <SourceStep
            onChosen={(source) => setStep({ at: "preview", source })}
            onBusy={(label, progress) => setStep({ at: "loading", label, progress })}
            onError={(message) => {
              setError(message);
              setStep({ at: "source" });
            }}
          />
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
    </>
  );
}

/** One tab in the row. Underlined when selected, the way the browser's own picker
 *  marks its active pane — three of these hand off immediately and never look
 *  selected, which is honest: the pane they open is Chrome's, not ours. */
function SurfaceTab({
  label,
  icon,
  onClick,
  selected = false,
  disabled = false,
  title,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`-mb-px flex flex-1 flex-col items-center justify-center gap-1 border-b-2 px-1 pt-1 pb-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-40 ${
        selected
          ? "border-brand text-brand"
          : "border-transparent text-ink-2 hover:border-line-2 hover:text-ink"
      }`}
    >
      {icon}
      <span className="text-[11.5px] leading-tight font-medium">{label}</span>
    </button>
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
 *  this dialog can offer the same four choices honestly. */
export function displayMediaOptions(surface: Surface): ScreenShareCaptureOptions {
  return { ...SCREEN_SHARE_OPTIONS, video: { displaySurface: surface } };
}
