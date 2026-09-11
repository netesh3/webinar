"use client";

import { useEffect, useRef } from "react";
import {
  LAYOUT_HINT,
  LAYOUT_LABEL,
  LAYOUT_MODES,
  PAGE_SIZES,
  type PageSize,
} from "@/lib/layout";
import { Toggle } from "../controls";
import { CheckIcon, GridIcon, PinIcon, SpeakerViewIcon } from "../icons";
import { useRoomUI } from "./context";

/* The Layout popover, from the control footer.
 *
 * Both halves of the brief in one surface: the three modes, and the personal
 * preferences that used to have nowhere to live. One surface rather than a menu
 * plus a separate settings drawer, because every one of these is the same kind of
 * decision — "what do I want to look at" — and splitting them across two dialogs
 * makes the second one undiscoverable.
 *
 * Everything here is this viewer's own. Nothing is published and no other
 * participant can observe it, which is why the footer says so at the bottom: a host
 * changing their view might otherwise reasonably assume they have changed the
 * audience's, and act on that.
 */

const ICON = {
  speaker: SpeakerViewIcon,
  grid: GridIcon,
  spotlight: PinIcon,
} as const;

export function LayoutMenu({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  /** When true, render inline under More (no floating chrome / absolute position). */
  embedded?: boolean;
}) {
  const { stage } = useRoomUI();
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.("[data-tool-slot='layout']")) return;
      if ((e.target as HTMLElement).closest?.("[data-tool-cell='layout']")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, embedded]);

  const body = (
    <>
      <p className="px-1.5 pt-0.5 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
        Change layout
      </p>

      <div className="space-y-0.5">
        {LAYOUT_MODES.map((mode) => {
          const Icon = ICON[mode];
          const active = stage.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              onClick={() => stage.setMode(mode)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                active ? "bg-brand/15 text-brand" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{LAYOUT_LABEL[mode]}</span>
                <span className="block text-[11px] leading-tight text-ink-3">
                  {LAYOUT_HINT[mode]}
                </span>
              </span>
              {active && <CheckIcon className="size-4 shrink-0" />}
            </button>
          );
        })}
      </div>

      <div className="mt-2 space-y-2.5 border-t border-line px-1.5 pt-2.5">
        <Toggle
          checked={stage.preferences.hideNonVideo}
          onChange={(v) => stage.setPreferences({ hideNonVideo: v })}
          label="Hide participants with no video"
          description="Most tiles in a large room are an avatar. Dropping them leaves fewer, bigger faces."
        />
        <Toggle
          checked={stage.preferences.onlySpeakers}
          onChange={(v) => stage.setPreferences({ onlySpeakers: v })}
          label="Show only the host and panelists"
          description="Leaves out anyone brought on stage for a single question."
        />

        {/* Only meaningful in the grid, which is the only mode that pages. */}
        {stage.mode === "grid" && (
          <div>
            <p className="mb-1 text-[12px] font-medium text-ink">Tiles per page</p>
            <div className="flex gap-1">
              {PAGE_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={stage.preferences.pageSize === size}
                  onClick={() => stage.setPreferences({ pageSize: size as PageSize })}
                  className={`h-8 flex-1 rounded-lg text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    stage.preferences.pageSize === size
                      ? "bg-brand text-white"
                      : "bg-surface-2 text-ink-2 hover:text-ink"
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] leading-tight text-ink-3">
              Only the tiles on this page are downloaded. The rest are unsubscribed, so a
              room of three hundred costs one page of video.
            </p>
          </div>
        )}

        {stage.pinnedParticipantId && (
          <button
            type="button"
            onClick={stage.clearPin}
            className="w-full rounded-lg bg-surface-2 px-2 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            Unpin the main tile
          </button>
        )}
      </div>

      <p className="mt-2 border-t border-line px-1.5 pt-2 text-[11px] leading-tight text-ink-3">
        Yours only — nobody else&apos;s view changes.
      </p>
    </>
  );

  if (embedded) {
    return <div ref={panel}>{body}</div>;
  }

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Stage layout"
      className="room-dark absolute bottom-full left-1/2 z-50 mb-2 w-[288px] max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-xl border border-line bg-surface p-2 shadow-2xl"
    >
      {body}
    </div>
  );
}
