"use client";

import { useEffect, useRef, useState } from "react";
import { useCompact } from "@/lib/compact";
import { LAYOUT_LABEL } from "@/lib/layout";
import { ChevronDownIcon } from "../icons";
import { useRoomUI } from "./context";
import { LAYOUT_ICON, LayoutMenu } from "./layout-menu";

/* Views, from the room header: ONE button showing the current view's icon,
 * with Speaker / Grid / Spotlight (and the rest of the view options) in its
 * dropdown. There used to be a segmented Speaker | Grid | Spotlight switch
 * beside a separate grid-icon menu — two controls for the same thing.
 *
 * The same LayoutMenu the More sheet uses — different chrome only. Two menus
 * with different options is how a host would change "hide non-video" in one
 * place and not see it in the other. Nothing to arrange on a CDN stage (a
 * single video element), so the caller leaves it out there.
 */
export function ViewsMenu() {
  const { stage } = useRoomUI();
  const compact = useCompact();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const Icon = LAYOUT_ICON[stage.mode];
  const name = `View: ${LAYOUT_LABEL[stage.mode]}`;

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
        aria-label={name}
        title={name}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex h-11 shrink-0 items-center justify-center gap-1 rounded-lg px-2.5 text-white/85 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:h-8 sm:px-2 ${
          open ? "bg-white/20 text-white" : "bg-white/10 hover:bg-white/20 hover:text-white"
        }`}
      >
        <Icon className="size-4" />
        <ChevronDownIcon
          className={`size-3 text-white/60 transition-transform ${open ? "rotate-180" : ""}`}
        />
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
