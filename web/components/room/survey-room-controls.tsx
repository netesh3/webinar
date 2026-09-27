"use client";

import { sendSummary } from "@/lib/survey";
import { Spinner } from "../controls";
import { ClipboardIcon, PlayIcon, StopIcon } from "../icons";
import { useRoomUI } from "./context";
import { useHostSurvey } from "./host-survey";

/* The feedback survey's row in the host's Polls panel: where it stands and one button.
 *
 * Setup lives in the schedule form (Edit webinar); here a host only sends it, or takes it
 * down. Once it is up, the pill on the stage (HostSurveyPill) takes over the counting. */

export function SurveyRoomControls() {
  const { slug } = useRoomUI();
  const s = useHostSurvey();
  if (!s?.host) return null;

  const sv = s.host.survey;
  const edit = `/host/${encodeURIComponent(slug)}/edit#survey`;

  if (!sv) {
    return (
      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-dashed border-line-2 px-3 py-2.5">
        <ClipboardIcon className="size-4 shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 text-[12.5px] text-ink-2">No feedback survey for this webinar.</p>
        <a
          href={edit}
          target="_blank"
          rel="noopener"
          className="shrink-0 text-[12.5px] font-medium text-brand hover:underline"
        >
          Add one
        </a>
      </div>
    );
  }

  const live = sv.status === "live";
  const line = live
    ? `On screen · ${sv.responses} of ${s.host.attended} answered`
    : sv.status === "closed"
      ? `Closed · ${sv.responses} answered`
      : `Ready · ${sendSummary(sv)}`;

  return (
    <div className={`mb-3 rounded-xl border px-3 py-2.5 ${live ? "border-ok/30 bg-ok-soft/40" : "border-line bg-surface-2/40"}`}>
      <div className="flex items-center gap-2.5">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-lg ${live ? "bg-ok-soft text-ok" : "bg-brand-soft text-brand"}`}
        >
          <ClipboardIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-ink">Feedback survey</p>
          <p className="truncate text-[11.5px] text-ink-3">{line}</p>
        </div>
        <button
          type="button"
          disabled={s.busy}
          onClick={() => void (live ? s.close() : s.send())}
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-colors disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            live ? "border border-line-2 text-ink hover:bg-surface-2" : "bg-brand text-stage hover:bg-brand-hover"
          }`}
        >
          {s.busy ? <Spinner className="size-3.5" /> : live ? <StopIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          {live ? "Take down" : sv.status === "closed" ? "Show again" : "Send survey"}
        </button>
      </div>
      {!live && (
        <a href={edit} target="_blank" rel="noopener" className="mt-1.5 inline-block text-[11.5px] font-medium text-brand hover:underline">
          Edit questions
        </a>
      )}
    </div>
  );
}
