"use client";

import { useEffect, useRef, useState } from "react";
import { useCompact } from "@/lib/compact";
import { LAYOUT_LABEL, LAYOUT_MODES } from "@/lib/layout";
import { GridIcon } from "../icons";
import { useRoomUI } from "./context";
import { LayoutMenu } from "./layout-menu";

/* Views, from the room header.
 *
 * The same LayoutMenu the footer and More sheet already use — different chrome
 * only. Two menus with different options is how a host would change "hide
 * non-video" in one place and not see it in the other.
 */

/** Speaker / Grid / Spotlight, in the room header rather than over the video. */
export function LayoutModeSwitch() {
  const { stage, cdnStage } = useRoomUI();
  if (cdnStage) return null;
  return (
    <div
      role="group"
      aria-label="Layout"
      className="flex items-center gap-0.5 rounded-lg bg-white/10 p-0.5"
    >
      {LAYOUT_MODES.map((option) => {
        const active = stage.mode === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => stage.setMode(option)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
              active ? "bg-white/25 text-white" : "text-white/70 hover:text-white"
            }`}
          >
            {LAYOUT_LABEL[option]}
          </button>
        );
      })}
    </div>
  );
}

export function ViewsMenu() {
  const compact = useCompact();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        data-views-button
        onClick={() => setOpen((v) => !v)}
        aria-label="Views"
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid size-11 place-items-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:size-8"
      >
        <GridIcon className="size-4" />
      </button>
      {open && (
        <LayoutMenu
          onClose={() => setOpen(false)}
          placement={compact ? "sheet" : "header"}
        />
      )}
    </div>
  );
}
