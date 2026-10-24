"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Modal, Spinner, Toggle } from "../controls";
import { useSession } from "../providers";
import { Badge, Button } from "../ui";
import { RecordingThumb } from "../recordings-tab";
import { RecordingPreviewPlayer } from "../recording-preview";
import { VideoUploadPanel } from "../video-upload";
import { api } from "@/lib/api";
import { FeatureReplayEngage, type Recording } from "@/lib/api-types";
import { formatClock, formatDuration } from "@/lib/format";
import { useHydrated } from "@/lib/clock";
import { eligibleRecordings, switchRecording } from "@/lib/simulive-create";
import { isUploadedVideo, withUploaded } from "@/lib/simulive-discover";
import { assistantLabelFor, autoAnswerDisclosure, autoModeAvailable } from "@/lib/qa-auto";
import { FormSection } from "./chrome";
import type { FormState, SetForm } from "./form-state";

/* The recording a simulive plays, on the schedule form: which one, how long it runs (which
 * is the session's length, so the When section shows it read-only), a "Change recording"
 * picker over this host's ready recordings, and what the audience will get besides the
 * video — the original engagement with replay_engage, the video alone without it.
 *
 * The list is the server's own (GET /api/host/recordings, HostReadyRecordings), which is the
 * same set the save is checked against, so nothing offered here is refused on save. */
export function SimuliveSourceSection({
  form,
  set,
  fields,
  editing,
  slug,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  editing: boolean;
  /** The saved simulive's slug, when editing: where its replay is curated. */
  slug?: string;
}) {
  const { account } = useSession();
  const hydrated = useHydrated();
  const replay = (account?.features ?? []).includes(FeatureReplayEngage);
  const autoMode = autoModeAvailable(account?.features);
  const [library, setLibrary] = useState<Recording[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  /* The chosen recording playing inline, and the one previewed in the picker. Neither player
   * mounts (so no media is fetched past the thumbnail) until asked for. */
  const [previewing, setPreviewing] = useState(false);
  const [previewInPicker, setPreviewInPicker] = useState<string | null>(null);
  // "Use a recording" | "Upload a video": where the video comes from.
  const [mode, setMode] = useState<"recording" | "upload">("recording");

  useEffect(() => {
    let active = true;
    api
      .hostRecordingLibrary()
      .then((list) => {
        if (active) setLibrary(eligibleRecordings(list ?? []));
      })
      .catch(() => {
        if (active) {
          setLibrary([]);
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const current = library?.find((r) => r.id === form.simuliveRecordingId) ?? null;

  function choose(next: Recording) {
    const patch = switchRecording(form, current, next);
    set("simuliveRecordingId", patch.simuliveRecordingId);
    set("durationMin", patch.durationMin);
    if (patch.topic !== form.topic) set("topic", patch.topic);
    setPicking(false);
    setPreviewInPicker(null);
    if (next.id !== current?.id) setPreviewing(false);
  }

  return (
    <FormSection
      title="The recording"
      description="Plays to everyone at the time you pick, as if it were live. The session runs as long as the recording."
    >
      <div id="simulive-recording" className="grid gap-3">
        <div
          role="tablist"
          aria-label="Where the video comes from"
          className="inline-flex w-fit rounded-lg border border-line bg-surface-2 p-0.5"
        >
          {(
            [
              ["recording", "Use a recording"],
              ["upload", "Upload a video"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              onClick={() => setMode(key)}
              className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium ${
                mode === key ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Hidden rather than unmounted, so switching tabs never stops an upload. */}
        <div hidden={mode !== "upload"}>
          <VideoUploadPanel
            compact
            onUploaded={(rec) => {
              setLibrary((list) => withUploaded(list, rec));
              setFailed(false);
              choose(rec);
              setMode("recording");
            }}
          />
        </div>

        {mode === "upload" ? null : library === null ? (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Spinner className="size-4" /> Loading your recordings…
          </div>
        ) : current ? (
          <>
            <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => setPreviewing(true)}
                aria-label={`Play ${current.topic}`}
                className="group w-full shrink-0 overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:w-44"
              >
                <RecordingThumb
                  src={api.recordingPlayURL(current, firstPlayable(current))}
                  durationMs={current.durationMs}
                  parts={current.parts?.length ?? 1}
                />
              </button>
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-semibold text-ink">{current.topic}</span>
                  {isUploadedVideo(current) && <Badge tone="brand">Uploaded</Badge>}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  {formatClock(current.durationMs)} ·{" "}
                  {hydrated
                    ? `${isUploadedVideo(current) ? "uploaded" : "recorded"} ${new Date(current.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
                    : current.createdAt}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setPreviewing((v) => !v)}
                  aria-expanded={previewing}
                  aria-controls="simulive-recording-preview"
                >
                  {previewing ? "Hide preview" : "Play"}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(true)}>
                  Change recording
                </Button>
              </div>
            </div>
            {previewing && (
              <div id="simulive-recording-preview">
                <RecordingPreviewPlayer key={current.id} rec={current} />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line-2 bg-surface-2 p-3">
            <p className="text-[12.5px] text-ink-2">
              {failed
                ? "Your recordings couldn't be loaded. Check your connection and try again."
                : form.simuliveRecordingId
                  ? "That recording isn't ready to replay, or is no longer in your library. Pick another."
                  : library.length === 0
                    ? "You have no ready recordings yet. Record a session first, or upload a video."
                    : "Pick the recording to play."}
            </p>
            {library.length > 0 && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(true)}>
                Pick a recording
              </Button>
            )}
          </div>
        )}

        {fields.simuliveRecordingId && (
          <p className="text-[12px] font-medium text-live">{fields.simuliveRecordingId}</p>
        )}

        <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
          {isUploadedVideo(current) ? (
            <>
              An uploaded video has no original session, so only the video plays: no chat, Q&amp;A or polls
              replay. New attendees still chat and ask questions live.
            </>
          ) : replay ? (
            <>
              ✨ The original chat, Q&amp;A and polls will replay at the times they happened.{" "}
              {editing && slug ? (
                <Link href={`/host/${slug}?tab=setup`} className="font-medium text-brand hover:underline">
                  Curate what replays
                </Link>
              ) : (
                <span className="text-ink-3">
                  You can curate what replays on the webinar&apos;s Setup tab after you schedule it.
                </span>
              )}
            </>
          ) : (
            <>Video only. Engagement replay isn&apos;t switched on for this account — ask us to turn it on.</>
          )}
        </p>

        {/* Auto mode (lib/qa-auto.ts): needs ai and replay_engage; off by default. */}
        {autoMode && (
          <div className="rounded-lg border border-line px-2 py-1">
            <Toggle
              checked={form.options.simuliveAutoAnswer === true}
              onChange={(next) => set("options", { ...form.options, simuliveAutoAnswer: next })}
              label="✨ Auto mode — the assistant answers new questions from your knowledge"
              description={autoAnswerDisclosure(assistantLabelFor(account?.name))}
            />
          </div>
        )}
      </div>

      <Modal
        open={picking}
        onClose={() => {
          setPicking(false);
          setPreviewInPicker(null);
        }}
        title="Choose a recording"
        description="Your ready recordings and uploaded videos, newest first. Ones still uploading appear once they finish."
        size="lg"
      >
        <ul className="grid gap-2 py-1">
          {(library ?? []).map((rec) => {
            const selected = rec.id === form.simuliveRecordingId;
            const open = previewInPicker === rec.id;
            return (
              <li key={rec.id} className="grid gap-2">
                <div className="flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={() => choose(rec)}
                    aria-pressed={selected}
                    className={`flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${
                      selected ? "border-brand bg-brand-soft" : "border-line bg-surface hover:border-brand-line"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium text-ink">{rec.topic}</span>
                        {isUploadedVideo(rec) && <Badge tone="brand">Uploaded</Badge>}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-ink-3">
                        {hydrated
                          ? new Date(rec.createdAt).toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : rec.createdAt}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[12px] text-ink-2 tabular-nums">
                      {formatDuration(Math.max(1, Math.ceil(rec.durationMs / 60_000)))}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-auto shrink-0 self-stretch"
                    onClick={() => setPreviewInPicker(open ? null : rec.id)}
                    aria-expanded={open}
                  >
                    {open ? "Hide" : "Preview"}
                  </Button>
                </div>
                {open && <RecordingPreviewPlayer key={rec.id} rec={rec} />}
              </li>
            );
          })}
        </ul>
      </Modal>
    </FormSection>
  );
}

function firstPlayable(rec: Recording): string {
  return rec.parts?.find((p) => p.status === "ready" && p.sizeBytes > 0)?.id ?? rec.id;
}
