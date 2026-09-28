"use client";

import { Spinner } from "../controls";
import { Button } from "../ui";

export function ActionBar({
  lead,
  rest,
  editing,
  showDraft,
  busy,
  onDraft,
}: {
  lead: string | null;
  rest: string;
  editing: boolean;
  showDraft: boolean;
  busy: "scheduled" | "draft" | null;
  onDraft: () => void;
}) {
  return (
    <div
      data-schedule-bar
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2.5 px-4 py-2.5 sm:px-5 lg:flex-row lg:items-center lg:gap-4 lg:py-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-[12.5px] leading-snug text-ink-2 lg:items-center">
          <span
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ok lg:mt-0"
            aria-hidden
          />
          <span className="min-w-0 lg:truncate">
            {lead && <strong className="font-semibold text-ink">{lead}</strong>}
            {rest && (
              <span>
                {lead ? " · " : ""}
                {rest}
              </span>
            )}
          </span>
        </p>
        <div className="flex gap-2 lg:shrink-0">
          {showDraft && (
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="flex-1 lg:flex-none"
              disabled={busy !== null}
              onClick={onDraft}
            >
              {busy === "draft" && <Spinner className="size-4" />}
              Save as draft
            </Button>
          )}
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
