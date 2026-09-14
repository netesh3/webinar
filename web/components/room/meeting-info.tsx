"use client";

import { useParticipants } from "@livekit/components-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useCompact } from "@/lib/compact";
import { CopyIcon, InfoIcon } from "../icons";
import { useShareOrigin, useToast } from "../providers";
import { useRoomUI } from "./context";
import { participantRole } from "./participants";

/* Meeting information, from the title in the header.
 *
 * The header used to show a truncated topic and, on a desktop only, a tiny room
 * ID on the right. A phone never saw the ID, and nobody saw the invite link
 * without opening More. This is that identity in one card, opened from the
 * title they are already looking at.
 *
 * The invite URL is the landing page, not the room — see invite-panel.tsx.
 * Sharing /room is useless: join needs a session or a joinKey. Copy does not
 * close the card, so someone reading the ID after copying the link is not
 * thrown back to the stage.
 *
 * Rows we do not have are omitted rather than faked: no PSTN numeric password,
 * no telephone, no participant telephony ID. Passcode is stripped from join
 * responses on purpose (see api-types Webinar.passcode) and is not invented here.
 */

export function MeetingInfo() {
  const { topic, slug, join, isHost, me } = useRoomUI();
  const origin = useShareOrigin();
  const { notify } = useToast();
  const compact = useCompact();
  const participants = useParticipants();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const webinarId = join.room.replace(/^webinar_/, "");
  const url = `${origin}/webinars/${slug}`;

  const hostName = isHost
    ? join.displayName || me.name
    : (() => {
        const host = participants.find((p) => participantRole(p) === "host");
        return host?.name || host?.identity || null;
      })();

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

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      notify("Couldn't reach the clipboard.", "info");
      return;
    }
    notify("Invitation copied.", "ok");
  }, [url, notify]);

  return (
    <div ref={wrap} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Meeting information"
        className="flex min-h-11 max-w-full items-center gap-1.5 rounded-full bg-white/10 py-1 pr-3 pl-1.5 text-left transition-colors hover:bg-white/16 outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:min-h-0 sm:h-7"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 sm:size-5">
          <InfoIcon className="size-3.5 sm:size-3" />
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold">{topic}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-labelledby={titleId}
          className={`room-dark z-50 rounded-xl border border-line bg-surface p-3.5 shadow-2xl ${
            compact
              ? "fixed inset-x-2 top-12 max-h-[calc(100dvh-5rem)] overflow-y-auto"
              : "absolute top-full left-0 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)]"
          }`}
        >
          <h2 id={titleId} className="pr-2 text-[15px] font-semibold text-ink">
            {topic}
          </h2>
          <dl className="mt-3 space-y-2.5">
            <InfoRow label="Invite link">
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-brand">{url}</span>
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  aria-label="Copy invite link"
                  className="grid size-11 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:size-8"
                >
                  <CopyIcon className="size-4" />
                </button>
              </span>
            </InfoRow>
            <InfoRow label="Webinar ID">
              <span className="tabular-nums">{webinarId}</span>
            </InfoRow>
            {hostName && (
              <InfoRow label="Host">
                {hostName}
                {isHost ? " (You)" : ""}
              </InfoRow>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2 text-[13px]">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 font-medium text-ink">{children}</dd>
    </div>
  );
}
