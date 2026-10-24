"use client";

import { useEffect, useRef } from "react";
import { leaveMenuItems } from "@/lib/panelists";
import { useRoomUI } from "./context";

/**
 * The Leave menu for a co-host: leave (the session carries on with the host), or end it for
 * everyone, which a co-host may do. Handing the host role over is the owner's alone
 * (requireTrueOwner on /transfer-host), so it is not offered — it used to be, through the
 * host's own menu, and always came back 403. Kept apart from HostLeaveMenu so the owner's
 * menu is untouched. Anchored to the Leave button, with the same outside-click guard.
 */
export function CoHostLeaveMenu({
  open,
  onClose,
  onLeave,
  onEnd,
}: {
  open: boolean;
  onClose: () => void;
  onLeave: () => void;
  onEnd: () => void;
}) {
  const { join } = useRoomUI();
  const meeting = !!join.meeting;
  const panel = useRef<HTMLDivElement | null>(null);
  const items = leaveMenuItems(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      // Leave button toggles open; ignore that click so we do not close-then-reopen.
      if ((e.target as HTMLElement).closest?.("[data-host-leave-trigger]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panel}
      role="menu"
      aria-label="Leave options"
      className="room-dark absolute right-0 bottom-full z-50 mb-2 w-[min(18rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-2xl"
    >
      {items.some((i) => i.kind === "leave") && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onLeave();
          }}
          className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2 outline-none focus-visible:bg-surface-2"
        >
          <span className="text-[13px] font-medium text-ink">
            {meeting ? "Leave meeting" : "Leave webinar"}
          </span>
          <span className="text-[12px] leading-relaxed text-ink-2">
            {meeting
              ? "Exit. The meeting carries on with the host."
              : "Exit. The webinar carries on with the host."}
          </span>
        </button>
      )}
      {items.some((i) => i.kind === "end") && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onEnd();
          }}
          className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-live/10 outline-none focus-visible:bg-live/10"
        >
          <span className="text-[13px] font-medium text-live">
            {meeting ? "End meeting for everyone" : "End webinar for everyone"}
          </span>
          <span className="text-[12px] leading-relaxed text-ink-2">
            {meeting
              ? "Disconnect everyone and mark the meeting as ended."
              : "Disconnect everyone and mark the webinar as ended."}
          </span>
        </button>
      )}
      <div className="my-1 h-px bg-line" role="separator" />
      <button
        type="button"
        role="menuitem"
        onClick={onClose}
        className="flex w-full items-center px-3.5 py-2.5 text-left text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 outline-none focus-visible:bg-surface-2"
      >
        Cancel
      </button>
    </div>
  );
}
