"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Modal, Spinner } from "../controls";
import { useSession } from "../providers";
import { Button } from "../ui";
import { RecordingThumb } from "../recordings-tab";
import { api } from "@/lib/api";
import { FeatureReplayEngage, type Recording } from "@/lib/api-types";
import { formatClock, formatDuration } from "@/lib/format";
import { useHydrated } from "@/lib/clock";
import { eligibleRecordings, switchRecording } from "@/lib/simulive-create";
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
  const [library, setLibrary] = useState<Recording[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);

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
  }

  return (
    <FormSection
      title="The recording"
      description="Plays to everyone at the time you pick, as if it were live. The session runs as long as the recording."
    >
      <div id="simulive-recording" className="grid gap-3">
        {library === null ? (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Spinner className="size-4" /> Loading your recordings…
          </div>
        ) : current ? (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 sm:flex-row sm:items-center">
            <div className="w-full shrink-0 overflow-hidden rounded-lg sm:w-44">
              <RecordingThumb
                src={api.recordingFileURL(current.webinar, firstPlayable(current))}
                durationMs={current.durationMs}
                parts={current.parts?.length ?? 1}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold text-ink">{current.topic}</p>
              <p className="mt-0.5 text-[12px] text-ink-3">
                {formatClock(current.durationMs)} ·{" "}
                {hydrated
                  ? `recorded ${new Date(current.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
                  : current.createdAt}
              </p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(true)}>
              Change recording
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line-2 bg-surface-2 p-3">
            <p className="text-[12.5px] text-ink-2">
              {failed
                ? "Your recordings couldn't be loaded. Check your connection and try again."
                : form.simuliveRecordingId
                  ? "That recording isn't ready to replay, or is no longer in your library. Pick another."
                  : library.length === 0
                    ? "You have no ready recordings yet. Record a session first, then replay it here."
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
          {replay ? (
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
            <>Video only. Engagement replay is a premium feature.</>
          )}
        </p>
      </div>

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose a recording"
        description="Your ready recordings, newest first. Ones still uploading appear once they finish."
        size="lg"
      >
        <ul className="grid gap-2 py-1">
          {(library ?? []).map((rec) => {
            const selected = rec.id === form.simuliveRecordingId;
            return (
              <li key={rec.id}>
                <button
                  type="button"
                  onClick={() => choose(rec)}
                  aria-pressed={selected}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${
                    selected ? "border-brand bg-brand-soft" : "border-line bg-surface hover:border-brand-line"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{rec.topic}</span>
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
