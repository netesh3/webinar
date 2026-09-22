"use client";

import { useEffect, useRef } from "react";

/* Are you sure you want to leave — for everybody who is not the host.
 *
 * It used to be one click and gone. The Leave button sits alone at the far right of the
 * control bar, which is also where a browser's close, a fullscreen exit and a window control
 * all live, and a mis-click there dropped somebody out of a live webinar with no step in
 * between. That is recoverable — the same link lets them back in while the session is running
 * — but it costs them the thread of whatever was being said, and they have to find the link
 * again to get back.
 *
 * A POPOVER AT THE BUTTON, not a modal, and the reasons are worth writing down because the
 * modal is the obvious choice:
 *
 *   The host already has one here. Clicking Leave as a host opens a menu anchored to the
 *   button (HostLeaveMenu). An attendee getting a centre-screen dialog from the same button
 *   in the same bar would be two interaction models for one control.
 *
 *   A modal hides the thing being decided about. Somebody who hit Leave by accident in the
 *   middle of a sentence can still see and hear the webinar behind this, which is exactly
 *   what they need in order to know they want to cancel. A backdrop covers it.
 *
 *   It is proportionate. Leaving is undoable; this is a speed bump, not a gate. A dialog that
 *   dims the room for a reversible action spends more of somebody's attention than the action
 *   is worth, and trains them to dismiss dialogs without reading.
 *
 *   The confirmation lands under the cursor. No travel to confirm, one click away to dismiss.
 *
 * Escape cancels, and the destructive button takes focus on open so Return confirms — a
 * two-key flow for anybody not using a mouse, which is the population most likely to have hit
 * the wrong control in the first place.
 */

/** Which of the three things somebody can be, because leaving means different things. */
export type LeaveRole = "attendee" | "panelist";

export function LeaveConfirm({
  open,
  role,
  onClose,
  onLeave,
}: {
  open: boolean;
  role: LeaveRole;
  onClose: () => void;
  onLeave: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const confirm = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stopped here so Escape does not also exit fullscreen or close a panel behind
        // this. The topmost thing asking a question is the thing Escape answers.
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      // The Leave button toggles this open; ignoring its own click is what stops the
      // close-then-reopen flicker. Same guard as HostLeaveMenu's.
      if ((e.target as HTMLElement).closest?.("[data-leave-trigger]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, onClose]);

  /* Focus moves to Leave, not to Cancel.
   *
   * The usual advice for a destructive confirmation is to focus the safe option, and it is
   * the wrong advice here: this popover only exists because somebody pressed Leave, so
   * confirming is what they asked for and Return should do it. Escape and click-away are both
   * one action from cancelling, and neither needs focus to work. */
  useEffect(() => {
    if (open) confirm.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Leave the webinar"
      className="room-dark absolute right-0 bottom-full z-50 mb-2 w-[min(19rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
    >
      <div className="px-3.5 pt-3 pb-2.5">
        <p className="text-[13.5px] font-semibold text-ink">Leave the webinar?</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          {/* A panelist's leave is the bigger one, and saying so is the point of splitting
              the copy: their camera and microphone are part of what the audience is
              watching, so it stops rather than a viewer count going down by one. */}
          {role === "panelist"
            ? "You're on the stage, so your camera and microphone go with you. You can come back with the same link while the session is live."
            : "You can rejoin with the same link while the session is still live."}
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-3.5 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-lg border border-line-2 px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          Stay
        </button>
        {/* Soft fill and live text, not a solid red one, and the reason is in the palette.

            room-dark redefines --color-live to #fb8078: a LIGHT red, for text and accents on a
            dark surface — which is how the host's own menu beside this uses it. `bg-live
            text-white` in here measures 2.3:1, under the 4.5:1 white text needs, and reads as
            washed-out salmon; it is a text colour being used as a fill.

            The dark palette's intended destructive pairing is the one it actually ships:
            --color-live-soft (#3a1917) behind --color-live. That measures 5.9:1, and it stops
            this button from being a second, lighter red sitting an inch from the bar's solid
            one — same word, same action, two colours. Red against Stay's neutral border is
            still what marks it as the committing action. */}
        <button
          ref={confirm}
          type="button"
          onClick={onLeave}
          className="h-9 rounded-lg border border-live/40 bg-live-soft px-3.5 text-[13px] font-semibold text-live transition-colors hover:border-live/60 hover:bg-live/20 outline-none focus-visible:ring-2 focus-visible:ring-live/50"
        >
          Leave
        </button>
      </div>
    </div>
  );
}
