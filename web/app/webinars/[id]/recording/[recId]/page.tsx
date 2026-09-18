"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ParticipantHeader } from "@/components/participant-header";
import { Badge, Button, Card } from "@/components/ui";
import { CopyField, Spinner } from "@/components/controls";
import { LockIcon } from "@/components/icons";
import { useToast } from "@/components/providers";
import { api } from "@/lib/api";
import type { PublicRecording } from "@/lib/api-types";
import { formatBytes, formatClock } from "@/lib/format";
import { useHydrated } from "@/lib/clock";

export default function RecordingReplayPage({
  params,
}: {
  params: Promise<{ id: string; recId: string }>;
}) {
  const { id: slug, recId } = use(params);
  const { notify } = useToast();
  const hydrated = useHydrated();

  const [recording, setRecording] = useState<PublicRecording | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [inputPasscode, setInputPasscode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await api.publicRecording(slug, recId);
        if (!cancelled) {
          setRecording(res);
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : "This recording is unavailable or private.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, recId]);

  async function handleUnlock(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!inputPasscode.trim()) {
      setUnlockError("Please enter the passcode.");
      return;
    }
    setUnlocking(true);
    setUnlockError(null);
    try {
      const res = await api.publicRecording(slug, recId, inputPasscode.trim());
      if (res.unlocked) {
        setRecording(res);
        setPasscode(inputPasscode.trim());
        notify("Passcode verified.", "ok");
      } else {
        setUnlockError("Incorrect passcode. Please try again.");
      }
    } catch (err) {
      setUnlockError(
        err instanceof Error ? err.message : "Failed to verify passcode.",
      );
    } finally {
      setUnlocking(false);
    }
  }

  const streamUrl = recording?.unlocked
    ? api.publicRecordingStreamURL(slug, recId, passcode || undefined)
    : "";

  const pageUrl = hydrated ? window.location.href : "";

  return (
    <>
      <ParticipantHeader />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        {loading ? (
          <div className="flex min-h-[360px] items-center justify-center">
            <Spinner className="size-8 text-brand" />
          </div>
        ) : error || !recording ? (
          <Card className="mx-auto max-w-lg p-8 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-warn-soft text-warn">
              <LockIcon className="size-6" />
            </div>
            <h1 className="text-xl font-semibold text-ink">Recording Unavailable</h1>
            <p className="mt-2 text-[14px] text-ink-2">
              {error || "This recording does not exist or is not publicly accessible."}
            </p>
            <div className="mt-6">
              <Link
                href={`/webinars/${slug}`}
                className="inline-flex h-9 items-center rounded-lg border border-line-2 bg-surface px-4 text-[13px] font-medium text-ink hover:bg-surface-2"
              >
                View Webinar Page
              </Link>
            </div>
          </Card>
        ) : !recording.unlocked ? (
          /* Passcode Protected Gate */
          <Card className="mx-auto max-w-md p-6 sm:p-8">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
              <LockIcon className="size-6" />
            </div>
            <h1 className="text-center text-xl font-semibold text-ink">
              Passcode Protected Recording
            </h1>
            <p className="mt-1 text-center text-[13.5px] text-ink-2">
              {recording.topic}
            </p>
            <p className="mt-2 text-center text-[13px] text-ink-3">
              Enter the passcode to watch this session replay.
            </p>

            <form onSubmit={handleUnlock} className="mt-6 space-y-4">
              <div>
                <label className="block text-[12.5px] font-medium text-ink mb-1">
                  Passcode
                </label>
                <input
                  type="password"
                  value={inputPasscode}
                  onChange={(e) => {
                    setInputPasscode(e.target.value);
                    if (unlockError) setUnlockError(null);
                  }}
                  placeholder="Enter passcode"
                  autoFocus
                  className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[14px] text-ink outline-none focus:border-brand"
                />
                {unlockError && (
                  <p className="mt-1.5 text-[12.5px] font-medium text-live">
                    {unlockError}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full"
                disabled={unlocking}
              >
                {unlocking ? <Spinner className="size-4" /> : "Unlock & Watch"}
              </Button>
            </form>
          </Card>
        ) : (
          /* Unlocked Video Replay Page */
          <div className="space-y-6">
            <Card className="overflow-hidden shadow-lg">
              <div className="relative aspect-video w-full bg-black">
                <video
                  key={recId}
                  src={streamUrl}
                  controls
                  playsInline
                  autoPlay={false}
                  preload="metadata"
                  controlsList="nodownload"
                  onError={() => {
                    setError("The video file is unavailable or could not be loaded from storage.");
                  }}
                  className="size-full"
                />
              </div>

              <div className="border-t border-line p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone="ok">Recording</Badge>
                      <span className="text-[11.5px] uppercase text-ink-3">
                        {recording.ext}
                      </span>
                      {recording.passcodeRequired && (
                        <Badge tone="neutral">
                          <span className="inline-flex items-center gap-1">
                            <LockIcon className="size-3" />
                            Passcode Protected
                          </span>
                        </Badge>
                      )}
                    </div>
                    <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
                      {recording.topic}
                    </h1>
                    <p className="mt-1 text-[13px] text-ink-3">
                      {recording.hostName ? `Hosted by ${recording.hostName} · ` : ""}
                      {recording.durationMs > 0
                        ? `${formatClock(recording.durationMs)} · `
                        : ""}
                      {formatBytes(recording.sizeBytes)} ·{" "}
                      {hydrated
                        ? new Date(recording.createdAt).toLocaleDateString(undefined, {
                            dateStyle: "medium",
                          })
                        : recording.createdAt}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2.5">
                    <a
                      href={streamUrl}
                      download
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2"
                    >
                      Download
                    </a>
                    <Link
                      href={`/webinars/${slug}`}
                      className="inline-flex h-9 items-center rounded-lg border border-line-2 bg-surface px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2"
                    >
                      Webinar Details
                    </Link>
                  </div>
                </div>

                {pageUrl && (
                  <div className="mt-5 border-t border-line pt-4">
                    <CopyField value={pageUrl} label="Share this replay" />
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </main>
    </>
  );
}
