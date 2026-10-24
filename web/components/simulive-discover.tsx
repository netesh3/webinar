"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Recording, Webinar } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { formatClock } from "@/lib/format";
import { daysLeftText, daysUntilExpiry, expiryTone } from "@/lib/recording-retention";
import { simuliveAllowed } from "@/lib/host-features";
import { simuliveScheduleHref } from "@/lib/simulive-create";
import {
  autopilotRecording,
  dismissAutopilot,
  firstPlayablePart,
  isAutopilotDismissed,
  isUploadedVideo,
  simuliveLibrary,
  withUploaded,
} from "@/lib/simulive-discover";
import { Spinner } from "./controls";
import { CloseIcon, PlayIcon } from "./icons";
import { useSession, useToast } from "./providers";
import { RecordingThumb } from "./recordings-tab";
import { RecordingPreviewModal } from "./recording-preview";
import { SimuliveInfoButton, useReplayEngage } from "./simulive-info";
import { Badge, Button, ButtonLink, Card, Empty } from "./ui";
import { VideoUploadPanel } from "./video-upload";

/* Making simulive findable (the explainer itself is simulive-info.tsx): the "Simulive" create
 * option and its recording picker (/host/new/simulive), the schedule page's heading, and the
 * card on an ended session's Results that offers to run it again. The rules are in
 * lib/simulive-discover.ts. */

/** The schedule page's heading: "Schedule a Simulive" when it was opened for a recording. */
export function ScheduleHeading() {
  const simulive = Boolean(useSearchParams().get("simulive")?.trim());
  const { account, status } = useSession();
  if (!simulive) {
    return (
      <h1 className="mb-1 text-[24px] font-semibold tracking-[-0.02em]">Schedule a webinar</h1>
    );
  }
  return (
    <>
      <div className="mb-1 flex items-center gap-1.5">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Schedule a Simulive</h1>
        <SimuliveInfoButton />
      </div>
      {/* The server refuses a simulive without the account's switch: say so before the form. */}
      {status !== "loading" && !simuliveAllowed(account) && (
        <p role="alert" className="mb-3 text-[13px] text-warn">
          Simulive isn&apos;t switched on for this account, so this can&apos;t be saved. Ask us to turn it on.
        </p>
      )}
    </>
  );
}

/** /host/new/simulive: every ready recording across the host's sessions, newest first; each
 *  opens the simulive schedule form for it. */
export function SimulivePicker() {
  const hydrated = useHydrated();
  const { account, status } = useSession();
  const [library, setLibrary] = useState<Recording[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The recording playing in the preview dialog: nothing past the thumbnails loads until then.
  const [previewing, setPreviewing] = useState<Recording | null>(null);
  // The video just uploaded, pointed out on its card.
  const [justUploaded, setJustUploaded] = useState<string | null>(null);
  // The account's simulive switch: without it the server refuses the schedule this leads to.
  const allowed = simuliveAllowed(account);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    api
      .hostRecordingLibrary()
      .then((list) => {
        if (active) setLibrary(simuliveLibrary(list));
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setLibrary([]);
        }
      });
    return () => {
      active = false;
    };
  }, [allowed]);

  return (
    <>
      <Link
        href="/host"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        ← Your webinars
      </Link>
      <div className="mb-1 flex items-center gap-1.5">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Schedule a Simulive</h1>
        <SimuliveInfoButton />
      </div>
      <p className="mb-5 text-[13.5px] text-ink-2">
        Pick a past recording, or upload a video. It plays at the time you choose, like a live webinar.
      </p>
      {allowed && (
        <Card className="mb-5 p-4">
          <VideoUploadPanel
            onUploaded={(rec) => {
              setLibrary((list) => withUploaded(list, rec));
              setFailed(false);
              setJustUploaded(rec.id);
            }}
          />
        </Card>
      )}

      {status !== "loading" && !allowed ? (
        <Empty
          title="Simulive isn't switched on for this account"
          hint="Ask us to turn on Simulive to replay your recordings as live sessions."
        />
      ) : library === null ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-ink-3">
          <Spinner className="size-4" /> Loading your recordings…
        </div>
      ) : failed ? (
        <Empty
          title="Your recordings couldn't be loaded"
          hint="Check your connection and reload the page."
        />
      ) : library.length === 0 ? (
        <Empty
          title="No recordings to replay yet"
          hint="A Simulive plays one of your recordings or a video you upload above. Turn on “Record automatically” when you schedule a webinar, or press Record in the room. Once the recording is ready it shows up here."
          action={<ButtonLink href="/host/new">Schedule a recorded webinar</ButtonLink>}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {library.map((rec) => (
            <li
              key={rec.id}
              className="overflow-hidden rounded-xl border border-line bg-surface transition-[border-color,box-shadow] hover:border-brand-line hover:shadow-[0_2px_8px_rgba(19,22,25,0.08)]"
            >
              {/* The picture previews the recording; the text below schedules it. */}
              <button
                type="button"
                onClick={() => setPreviewing(rec)}
                aria-label={`Preview ${rec.topic}`}
                className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <RecordingThumb
                  src={api.recordingPlayURL(rec, firstPlayablePart(rec))}
                  durationMs={rec.durationMs}
                  parts={rec.parts?.length ?? 1}
                />
              </button>
              {justUploaded === rec.id && (
                <p className="bg-ok-soft px-3 py-1.5 text-[12px] font-medium text-ok">
                  Uploaded. Schedule it as a Simulive below.
                </p>
              )}
              <Link
                href={simuliveScheduleHref(rec)}
                className="group block outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <div className="p-3">
                  <p className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-semibold text-ink">{rec.topic}</span>
                    {isUploadedVideo(rec) && <Badge tone="brand">Uploaded</Badge>}
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-3">
                    {formatClock(rec.durationMs)} ·{" "}
                    {hydrated
                      ? new Date(rec.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })
                      : rec.createdAt.slice(0, 10)}
                  </p>
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand">
                    <PlayIcon className="size-3" />
                    Replay as Simulive
                  </p>
                </div>
              </Link>
              <button
                type="button"
                onClick={() => setPreviewing(rec)}
                className="mx-1.5 mb-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <PlayIcon className="size-3" />
                Preview
              </button>
              {isUploadedVideo(rec) && (
                <UploadedVideoActions
                  rec={rec}
                  onChanged={(next) =>
                    setLibrary((list) => (list ?? []).map((r) => (r.id === next.id ? next : r)))
                  }
                  onDeleted={() => setLibrary((list) => (list ?? []).filter((r) => r.id !== rec.id))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <RecordingPreviewModal rec={previewing} onClose={() => setPreviewing(null)} />
    </>
  );
}

/** An uploaded video's upkeep on its picker card: when it is deleted, Keep longer, Delete. */
function UploadedVideoActions({
  rec,
  onChanged,
  onDeleted,
}: {
  rec: Recording;
  onChanged: (rec: Recording) => void;
  onDeleted: () => void;
}) {
  const { notify } = useToast();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const days = hydrated ? daysUntilExpiry(rec.expiresAt) : null;

  async function keep() {
    setBusy(true);
    try {
      const kept = await api.keepVideo(rec.id);
      onChanged(kept);
      notify(
        kept.expiresAt
          ? `Kept until ${new Date(kept.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.`
          : "Kept longer.",
        "ok",
      );
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not keep that video.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteVideo(rec.id);
      onDeleted();
      notify("Video deleted.", "ok");
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not delete that video.", "error");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
      {days !== null && <Badge tone={expiryTone(days)}>{daysLeftText(days)}</Badge>}
      <span className="flex-1" />
      {rec.canExtend && (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void keep()}>
          Keep 3 more months
        </Button>
      )}
      {confirming ? (
        <Button type="button" variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>
          Delete for good
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
          Delete
        </Button>
      )}
    </div>
  );
}

/** On an ended session's Results, above everything: offer to run it again as a simulive.
 *  Closing it is remembered for this session in this browser. */
export function SimuliveAutopilotCard({
  webinar: w,
  recordings,
}: {
  webinar: Webinar;
  recordings: Recording[];
}) {
  const { account } = useSession();
  const replay = useReplayEngage();
  const hydrated = useHydrated();
  const [closed, setClosed] = useState(false);
  const rec = autopilotRecording(w, recordings, account);
  if (!rec || closed || !hydrated) return null;
  if (isAutopilotDismissed(window.localStorage, w.id)) return null;

  function close() {
    dismissAutopilot(window.localStorage, w.id);
    setClosed(true);
  }

  return (
    <Card className="relative mb-4 border-brand-line bg-brand-soft p-4 sm:p-5">
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss"
        title="Dismiss"
        className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-ink"
      >
        <CloseIcon className="size-4" />
      </button>
      <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand text-on-brand">
          <PlayIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-[14.5px] font-semibold text-ink">
            Run this again on autopilot
            <SimuliveInfoButton />
          </p>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Replay it as a Simulive for new registrants, with the original chat and Q&amp;A.
            {!replay && (
              <>
                {" "}
                <Badge tone="warn">Available on request</Badge>
              </>
            )}
          </p>
        </div>
        <ButtonLink href={simuliveScheduleHref(rec)} size="sm" className="shrink-0">
          <PlayIcon className="size-3" />
          Schedule a Simulive
        </ButtonLink>
      </div>
    </Card>
  );
}
