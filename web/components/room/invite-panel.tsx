"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { CopyIcon, SendIcon } from "../icons";
import { useShareOrigin, useToast } from "../providers";
import { useRoomUI } from "./context";

/* Invite, from inside the room.
 *
 * Two buttons, Zoom-style — not a window. The link this shares is the LANDING
 * page, not the room: whoever opens it lands on the front door and still has to
 * get through whatever the host set up — register, or type a passcode, or wait
 * to be approved. Sharing the room URL directly would look more helpful and
 * would hand out nothing usable, because the room exchanges a join key or a
 * session for a token and a stranger has neither.
 *
 * Available to the audience as well as the host, deliberately. The slug has
 * always been the shareable part of this product — it is what a forwarded
 * invitation contains — so an attendee passing it to a colleague can only offer
 * the same front door they came through themselves.
 */

const subscribeNothing = () => () => {};
const readCanShare = () =>
  typeof navigator !== "undefined" && typeof navigator.share === "function";
const readCanShareOnServer = () => false;

export function InviteMenu({
  onClose,
  onUsed,
  embedded = false,
}: {
  onClose: () => void;
  /** Fired once the invitation is actually copied or shared — not on a plain
   *  dismiss — so Invite can surface as recently used like every other action
   *  tool. */
  onUsed?: () => void;
  /** When true, render inline under More (no floating chrome / absolute position). */
  embedded?: boolean;
}) {
  const { slug, topic } = useRoomUI();
  const origin = useShareOrigin();
  const { notify } = useToast();
  const panel = useRef<HTMLDivElement | null>(null);

  const url = `${origin}/webinars/${slug}`;
  const message = `${topic}\n\nJoin here: ${url}`;

  // Read through useSyncExternalStore rather than during render: `navigator.share`
  // cannot be answered on the server, and checking it in a render is a hydration
  // mismatch on a popover that otherwise looks fine.
  const canShare = useSyncExternalStore(
    subscribeNothing,
    readCanShare,
    readCanShareOnServer,
  );

  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.("[data-tool-slot='invite']")) return;
      if ((e.target as HTMLElement).closest?.("[data-tool-cell='invite']")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, embedded]);

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // Refused permission, or an insecure origin.
      notify("Couldn't reach the clipboard.", "info");
      return;
    }
    notify("Invitation copied.", "ok");
    onUsed?.();
    onClose();
  }

  async function share() {
    try {
      await navigator.share({ title: topic, text: message, url });
      onUsed?.();
    } catch {
      // A cancelled share sheet throws exactly like a failed one, and telling
      // somebody their deliberate dismissal went wrong is worse than saying
      // nothing — but it also means this was not a genuine "use".
    }
    onClose();
  }

  const body = (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={() => void copyMessage()}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] font-medium text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <CopyIcon className="size-4 shrink-0" />
        Copy invitation
      </button>

      {canShare && (
        <button
          type="button"
          onClick={() => void share()}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] font-medium text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <SendIcon className="size-4 shrink-0" />
          Share…
        </button>
      )}
    </div>
  );

  if (embedded) {
    return <div ref={panel}>{body}</div>;
  }

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Invite people"
      className="room-dark absolute bottom-full left-1/2 z-50 mb-2 w-[220px] -translate-x-1/2 rounded-xl border border-line bg-surface p-1.5 shadow-2xl"
    >
      {body}
    </div>
  );
}
