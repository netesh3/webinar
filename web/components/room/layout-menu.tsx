"use client";

import { useEffect, useRef, useState } from "react";
import {
  LAYOUT_HINT,
  LAYOUT_LABEL,
  LAYOUT_MODES,
  PAGE_SIZES,
  type LayoutMode,
  type PageSize,
} from "@/lib/layout";
import { Toggle } from "../controls";
import {
  CheckIcon,
  ExpandIcon,
  GridIcon,
  PinIcon,
  SpeakerViewIcon,
} from "../icons";
import { useRoomUI } from "./context";

/* The Layout / Views menu.
 *
 * One component, three chrome variants: a card off the footer button, a card
 * under the header Views icon, and inline in More. The options are the same
 * everywhere so a preference flipped in More is the one the header still shows.
 *
 * Everything here is this viewer's own. Nothing is published. The footer note
 * says so because a host changing their view might otherwise assume they have
 * changed the audience's.
 */

const ICON = {
  speaker: SpeakerViewIcon,
  grid: GridIcon,
  spotlight: PinIcon,
} as const;

const COMPACT_LABEL: Record<LayoutMode, string> = {
  speaker: "Speaker view",
  grid: "Gallery view",
  spotlight: "Spotlight",
};

export function LayoutMenu({
  onClose,
  embedded = false,
  placement,
}: {
  onClose: () => void;
  /** When true, render inline under More (no floating chrome / absolute position). */
  embedded?: boolean;
  /** Where the menu is anchored. Header opens downward; bar opens upward. */
  placement?: "bar" | "header" | "sheet" | "embedded";
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const where = placement ?? (embedded ? "embedded" : "bar");
  const compact = where === "header" || where === "sheet";
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () =>
      setFullscreen(
        document.fullscreenElement === document.querySelector("[data-stage]"),
      );
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    if (where === "embedded") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.("[data-tool-slot='layout']")) return;
      if ((e.target as HTMLElement).closest?.("[data-tool-cell='layout']")) return;
      if ((e.target as HTMLElement).closest?.("[data-views-button]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, where]);

  const body = compact ? (
    <CompactBody
      fullscreen={fullscreen}
      onToggleFullscreen={() => {
        const el = document.querySelector("[data-stage]");
        if (!(el instanceof HTMLElement)) return;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el.requestFullscreen().catch(() => {});
      }}
    />
  ) : (
    <DetailedBody />
  );

  if (where === "embedded") {
    return <div ref={panel}>{body}</div>;
  }

  const position =
    where === "header"
      ? "absolute top-full right-0 z-50 mt-2"
      : where === "sheet"
        ? "fixed inset-x-2 top-12 z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto"
        : "absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2";

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Views"
      className={`room-dark w-[288px] max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-surface p-2 shadow-2xl ${position}`}
    >
      {body}
    </div>
  );
}

function CompactBody({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { stage } = useRoomUI();
  return (
    <>
      <p className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
        My view
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
              className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-ink transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <span className="grid size-4 shrink-0 place-items-center">
                {active && <CheckIcon className="size-3.5 text-brand" />}
              </span>
              <span className="min-w-0 flex-1">{COMPACT_LABEL[mode]}</span>
              <Icon className="size-4 shrink-0 text-ink-3" />
            </button>
          );
        })}
      </div>

      <div className="mt-1 space-y-0.5 border-t border-line pt-1">
        <MenuCheck
          checked={stage.preferences.hideSelf}
          onChange={(v) => stage.setPreferences({ hideSelf: v })}
          label="Hide self view"
        />
        <MenuCheck
          checked={stage.preferences.hideNonVideo}
          onChange={(v) => stage.setPreferences({ hideNonVideo: v })}
          label="Hide non-video participants"
        />
        <MenuCheck
          checked={stage.preferences.onlySpeakers}
          onChange={(v) => stage.setPreferences({ onlySpeakers: v })}
          label="Show only host and panelists"
        />
      </div>

      {stage.mode === "grid" && <TilesPerPage />}

      <div className="mt-1 border-t border-line pt-1">
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-ink transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <ExpandIcon className="size-4 shrink-0 text-ink-3" />
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>

      {stage.pinnedParticipantId && (
        <button
          type="button"
          onClick={stage.clearPin}
          className="mt-1 min-h-11 w-full rounded-lg px-2 text-left text-[13px] text-ink-2 hover:bg-surface-2"
        >
          Unpin the main tile
        </button>
      )}

      <p className="mt-1 border-t border-line px-2 pt-2 text-[11px] leading-tight text-ink-3">
        Yours only — nobody else&apos;s view changes.
      </p>
    </>
  );
}

function DetailedBody() {
  const { stage } = useRoomUI();
  return (
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
          checked={stage.preferences.hideSelf}
          onChange={(v) => stage.setPreferences({ hideSelf: v })}
          label="Hide self view"
          description="Your camera tile only. A screen you are sharing stays."
        />
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

        {stage.mode === "grid" && <TilesPerPage detailed />}

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
}

function TilesPerPage({ detailed = false }: { detailed?: boolean }) {
  const { stage } = useRoomUI();
  return (
    <div className={detailed ? "" : "border-t border-line px-2 pt-2"}>
      <p className="mb-1 text-[12px] font-medium text-ink">Tiles per page</p>
      <div className="flex gap-1">
        {PAGE_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={stage.preferences.pageSize === size}
            onClick={() => stage.setPreferences({ pageSize: size as PageSize })}
            className={`h-11 flex-1 rounded-lg text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:h-8 ${
              stage.preferences.pageSize === size
                ? "bg-brand text-white"
                : "bg-surface-2 text-ink-2 hover:text-ink"
            }`}
          >
            {size}
          </button>
        ))}
      </div>
      {detailed && (
        <p className="mt-1 text-[11px] leading-tight text-ink-3">
          Only the tiles on this page are downloaded. The rest are unsubscribed, so a
          room of three hundred costs one page of video.
        </p>
      )}
    </div>
  );
}

function MenuCheck({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-ink transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {checked && <CheckIcon className="size-3.5 text-brand" />}
      </span>
      {label}
    </button>
  );
}
