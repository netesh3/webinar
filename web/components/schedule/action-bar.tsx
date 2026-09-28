"use client";

import { Spinner } from "../controls";
import { CheckIcon, MaterialIcon } from "../icons";
import { Button } from "../ui";

export type DraftStatus =
  | { kind: "pristine" }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "saved"; ago: string }
  | { kind: "unavailable" };

export type FollowUpSummary =
  | { enabled: number; custom: boolean }
  | "failed"
  | null;

function followUpsText(f: FollowUpSummary): string {
  if (f == null) return "Follow-ups: loading…";
  if (f === "failed") return "Follow-ups: couldn't load";
  return `Follow-ups: ${f.custom ? "customised" : "default"} (${f.enabled} message${f.enabled === 1 ? "" : "s"})`;
}

export function ActionBar({
  lead,
  rest,
  editing,
  showDraft,
  busy,
  status,
  followUps,
  onFollowUps,
  followUpsActive,
  onDraft,
}: {
  lead: string | null;
  rest: string;
  editing: boolean;
  showDraft: boolean;
  busy: "scheduled" | "draft" | null;
  status: DraftStatus;
  /** Null until the follow-ups step has loaded its messages. */
  followUps: FollowUpSummary;
  onFollowUps: () => void;
  followUpsActive: boolean;
  onDraft: () => void;
}) {
  return (
    <div
      data-schedule-bar
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_18px_rgba(15,23,42,0.07)]"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2.5 px-4 py-2.5 sm:px-5 lg:flex-row lg:items-center lg:gap-4 lg:py-3">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-start gap-2 text-[12.5px] leading-snug text-ink-2 lg:items-center">
            <span
              className="mt-1.5 size-2 shrink-0 rounded-full bg-ok shadow-[0_0_0_3px_var(--color-ok-soft)] lg:mt-0"
              aria-hidden
            />
            <span className="min-w-0 lg:truncate">
              {lead && (
                <strong className="font-semibold text-ink">{lead}</strong>
              )}
              {rest && (
                <span>
                  {lead ? " · " : ""}
                  {rest}
                </span>
              )}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap gap-x-3.5 gap-y-0.5 pl-4 text-[11.5px] text-ink-3">
            <DraftStatusText status={status} />
            <span className="inline-flex items-center gap-1">
              <MaterialIcon name="mail" className="size-3.5" />
              {followUpsText(followUps)}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2 lg:shrink-0 lg:flex-nowrap">
          {showDraft && (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="flex-1 px-4 lg:flex-none"
              disabled={busy !== null}
              onClick={onDraft}
            >
              {busy === "draft" && <Spinner className="size-4" />}
              Save as draft
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            aria-pressed={followUpsActive}
            className="flex-1 border-brand-line bg-brand-soft text-brand hover:bg-brand-soft/70 lg:flex-none"
            onClick={onFollowUps}
          >
            <MaterialIcon name="mail" className="size-4" />
            Set up follow-ups
          </Button>
          <Button
            type="submit"
            size="lg"
            className="flex-1 lg:flex-none"
            disabled={busy !== null}
          >
            {busy === "scheduled" && <Spinner className="size-4" />}
            {editing ? "Save changes" : "Schedule"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DraftStatusText({ status }: { status: DraftStatus }) {
  switch (status.kind) {
    case "saving":
      return (
        <span className="inline-flex items-center gap-1 text-ink-2">
          <Spinner className="size-3" />
          Saving…
        </span>
      );
    case "saved":
      return (
        <span
          className="inline-flex items-center gap-1 font-medium text-ok"
          title="Kept in this browser until you save as a draft or schedule."
        >
          <CheckIcon className="size-3" />
          Draft saved on this device · {status.ago}
        </span>
      );
    case "unsaved":
      return <span className="font-medium text-warn">Unsaved changes</span>;
    case "unavailable":
      return (
        <span className="font-medium text-warn">
          Unsaved changes — this browser won&apos;t keep a copy
        </span>
      );
    default:
      return <span>No changes yet</span>;
  }
}
