"use client";

import {
  useBackgroundStatus,
  VIRTUAL_BACKGROUNDS,
  type BackgroundChoice,
} from "@/lib/backgrounds";
import { Spinner } from "../controls";
import { ArrowLeftIcon, ChevronRightIcon, CloseIcon } from "../icons";
import { Tile } from "./background-picker";

/* Virtual background, one click from the camera button.
 *
 * Blur was already in the camera menu; the stills were only in Video settings, a
 * modal away. This is the row that sits under "Blur my background" and the panel it
 * opens. It writes the same `prefs.background` the settings grid writes, so the two
 * can never disagree.
 *
 * The panel stays open after a pick: the point of having it beside the video is to
 * try a few and watch the change. It closes with the menu, its × or Escape.
 */

/** The menu row: "Virtual background" with the active still's thumbnail, or "Off". */
export function VirtualBackgroundRow({
  choice,
  expanded,
  controls,
  onOpen,
}: {
  choice: BackgroundChoice;
  expanded: boolean;
  controls?: string;
  onOpen: () => void;
}) {
  const active =
    choice.mode === "image" ? VIRTUAL_BACKGROUNDS.find((b) => b.id === choice.id) : undefined;
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      onClick={onOpen}
      className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-[13px] text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:bg-surface-2 ${
        expanded ? "bg-surface-2" : ""
      }`}
    >
      <span className="min-w-0 flex-1 truncate">Virtual background</span>
      {active ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={active.src}
          alt={active.label}
          title={active.label}
          decoding="async"
          draggable={false}
          className="h-5 w-8 shrink-0 rounded-[3px] object-cover ring-1 ring-line"
        />
      ) : (
        <span className="text-[12px] text-ink-3">Off</span>
      )}
      <ChevronRightIcon className="size-3.5 shrink-0 text-ink-3" />
    </button>
  );
}

/** The panel of stills. Positioned by the caller. */
export function VirtualBackgroundPanel({
  id,
  choice,
  onSelect,
  onClose,
  className = "",
}: {
  id: string;
  choice: BackgroundChoice;
  onSelect: (next: BackgroundChoice) => void;
  onClose: () => void;
  className?: string;
}) {
  const status = useBackgroundStatus();
  const isImage = choice.mode === "image";
  const applying = isImage && status.phase === "preparing";

  return (
    <div
      id={id}
      role="dialog"
      aria-label="Virtual background"
      className={`room-dark w-[18.5rem] max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-surface p-3 shadow-xl sm:w-[20rem] ${className}`}
    >
      <div className="mb-2.5 flex min-h-6 items-center gap-2">
        {/* Phones have no room beside the menu, so the panel replaces it; this is the way back. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to camera menu"
          className="-ml-1 grid size-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink sm:hidden"
        >
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-ink">Virtual background</h3>
        {applying ? (
          <span role="status" className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <Spinner className="size-3" />
            Applying…
          </span>
        ) : isImage ? (
          <button
            type="button"
            onClick={() => onSelect({ mode: "none" })}
            className="rounded px-1 text-[12px] font-medium text-brand hover:underline"
          >
            Turn off
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="hidden size-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink sm:grid"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {VIRTUAL_BACKGROUNDS.map((bg) => {
          const active = isImage && choice.id === bg.id;
          return (
            <Tile
              key={bg.id}
              label={bg.label}
              active={active}
              busy={applying}
              disabled={false}
              onClick={() => onSelect({ mode: "image", id: bg.id })}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={bg.src}
                alt=""
                decoding="async"
                draggable={false}
                className="size-full object-cover"
              />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-3 pb-0.5 text-left text-[10px] font-medium text-white">
                {bg.label}
              </span>
            </Tile>
          );
        })}
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-ink-3">
        Segmentation runs on your own device — the video is never sent anywhere to be
        processed.
      </p>
    </div>
  );
}
