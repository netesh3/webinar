"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Recording } from "@/lib/api-types";
import {
  MAX_VIDEO_BYTES,
  VIDEO_ACCEPT,
  forgetUpload,
  formatBytes,
  titleFromFilename,
  uploadVideo,
  videoFileProblem,
  xhrPut,
  type UploadProgress,
} from "@/lib/video-uploader";
import { Spinner } from "./controls";
import { useAppConfig } from "./providers";
import { Button } from "./ui";

/* "Upload a video" for Simulive: on the /host/new/simulive picker and the schedule form's
 * "The recording" section. The file goes straight to cloud storage in parts (lib/video-
 * uploader.ts), with a progress bar and Cancel; choosing the same file again after a reload
 * carries on from what was sent. When the server has checked it, it is a recording like any
 * other (an "Uploaded" one) and onUploaded gets it. */

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; file: File; progress: UploadProgress }
  | { kind: "checking"; file: File }
  | { kind: "error"; message: string };

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function VideoUploadPanel({
  onUploaded,
  compact = false,
}: {
  onUploaded: (rec: Recording) => void;
  /** Inside the schedule form: no heading of its own. */
  compact?: boolean;
}) {
  const config = useAppConfig();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [title, setTitle] = useState("");
  const [dragging, setDragging] = useState(false);
  const titleRef = useRef("");
  const ctl = useRef<AbortController | null>(null);
  const uploadId = useRef<string | null>(null);

  // Leaving the page stops sending (the upload resumes if the same file is chosen again).
  useEffect(() => () => ctl.current?.abort(), []);

  // An upload in progress: closing the tab would stop it, so ask first.
  const busy = phase.kind === "uploading" || phase.kind === "checking";
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  if (!config.videoUploadEnabled) {
    return compact ? (
      <p className="text-[12.5px] text-ink-3">Uploading videos isn&apos;t available on this server.</p>
    ) : null;
  }

  async function start(file: File | undefined) {
    if (!file || busy) return;
    const problem = videoFileProblem(file, MAX_VIDEO_BYTES);
    if (problem) {
      setPhase({ kind: "error", message: problem });
      return;
    }
    const startTitle = titleRef.current.trim() || titleFromFilename(file.name);
    setTitle(startTitle);
    titleRef.current = startTitle;
    const abort = new AbortController();
    ctl.current = abort;
    uploadId.current = null;
    setPhase({ kind: "uploading", file, progress: { percent: 0, sentBytes: 0, totalBytes: file.size } });
    try {
      const rec = await uploadVideo(
        file,
        {
          start: api.startVideoUpload,
          status: api.videoUploadStatus,
          partURLs: async (id, parts) => (await api.videoUploadParts(id, parts)).urls,
          complete: (id, t) => {
            setPhase({ kind: "checking", file });
            return api.completeVideoUpload(id, t);
          },
          put: xhrPut,
          store: storage(),
        },
        {
          signal: abort.signal,
          title: () => titleRef.current,
          onStarted: (id) => {
            uploadId.current = id;
          },
          onProgress: (progress) =>
            setPhase((p) => (p.kind === "uploading" ? { kind: "uploading", file, progress } : p)),
        },
      );
      setPhase({ kind: "idle" });
      setTitle("");
      titleRef.current = "";
      onUploaded(rec);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setPhase({
        kind: "error",
        message:
          e instanceof ApiError
            ? e.message
            : "The upload stopped. Check your connection and choose the same file again to carry on.",
      });
    }
  }

  async function cancel() {
    const file = phase.kind === "uploading" || phase.kind === "checking" ? phase.file : null;
    ctl.current?.abort();
    setPhase({ kind: "idle" });
    if (file) forgetUpload(storage(), file);
    const id = uploadId.current;
    uploadId.current = null;
    if (id) await api.cancelVideoUpload(id).catch(() => {});
  }

  return (
    <div className="grid gap-3">
      {!compact && (
        <div>
          <p className="text-[14px] font-semibold text-ink">Upload a video</p>
          <p className="mt-0.5 text-[12.5px] text-ink-2">
            Play your own video as a Simulive. MP4 or MOV with H.264 video and AAC audio, up to{" "}
            {formatBytes(MAX_VIDEO_BYTES)}. Kept 30 days, and you can keep it longer 3 months at a time.
          </p>
        </div>
      )}

      {phase.kind === "uploading" || phase.kind === "checking" ? (
        <div className="grid gap-2 rounded-xl border border-line bg-surface p-3">
          <div className="flex items-center justify-between gap-3 text-[12.5px]">
            <span className="min-w-0 truncate font-medium text-ink">{phase.file.name}</span>
            <span className="shrink-0 font-mono text-ink-2 tabular-nums">
              {phase.kind === "checking"
                ? "Checking…"
                : `${formatBytes(phase.progress.sentBytes)} of ${formatBytes(phase.progress.totalBytes)} · ${phase.progress.percent}%`}
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase.kind === "checking" ? 100 : phase.progress.percent}
          >
            <div
              className="h-full bg-brand transition-all"
              style={{ width: `${phase.kind === "checking" ? 100 : phase.progress.percent}%` }}
            />
          </div>
          <label className="grid gap-1 text-[12px] text-ink-2">
            Title
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                titleRef.current = e.target.value;
              }}
              maxLength={200}
              className="h-9 rounded-lg border border-line-2 bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
              {phase.kind === "checking" ? (
                <>
                  <Spinner className="size-3" /> Checking the video can play everywhere…
                </>
              ) : (
                "Keep this page open until it finishes."
              )}
            </p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void start(e.dataTransfer.files?.[0]);
          }}
          className={`flex flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-6 text-center outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            dragging ? "border-brand bg-brand-soft" : "border-line-2 bg-surface-2 hover:border-brand-line"
          }`}
        >
          <span className="text-[13px] font-medium text-ink">Drag a video here, or click to choose one</span>
          <span className="text-[12px] text-ink-3">
            MP4 or MOV (H.264 + AAC), up to {formatBytes(MAX_VIDEO_BYTES)}. Counts toward your recording storage.
          </span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void start(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {phase.kind === "error" && (
        <p role="alert" className="text-[12px] font-medium text-live">
          {phase.message}
        </p>
      )}
    </div>
  );
}
