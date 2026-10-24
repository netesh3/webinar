"use client";

import { useRemoteParticipants } from "@livekit/components-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { mergeHostCandidates, metadataCoHost } from "@/lib/host-transfer";
import { HOST_LEAVE_NO_COHOST_NOTE, handoverLabel, leaveMenuItems } from "@/lib/panelists";
import { Spinner } from "../controls";
import { useToast } from "../providers";
import { useRoomUI } from "./context";
import { participantRole } from "./participants";

export {
  eligibleHostCandidates,
  isEligibleHostCandidate,
  mergeHostCandidates,
} from "@/lib/host-transfer";

/**
 * The host's Leave menu, webinars and meetings alike (lib/panelists.ts leaveMenuItems).
 * Anchored to the Leave button.
 *
 * With co-hosts in the room: "Make <co-host> the host and leave", one line per co-host, and
 * End for everyone. Picking a co-host hands over (api handleTransferHost: ownership moves,
 * the co-host becomes the host, this host an ordinary panelist) and then leaves. Only a
 * co-host can take over — the host decides who could run the room by making them co-host.
 *
 * With none: a plain Leave and End, and a note that making someone co-host first is what
 * lets the host hand over. Leaving without a successor is what a closed tab does today: a
 * webinar's stage carries on and the host can rejoin; a meeting carries on too, but nobody is
 * let in from the lobby, and the empty-room sweeper ends it once the last person goes. Nobody
 * is made host automatically.
 */
export function HostLeaveMenu({
  open,
  onClose,
  onEnd,
}: {
  open: boolean;
  onClose: () => void;
  onEnd: () => void;
}) {
  const { slug, join, roster, leave } = useRoomUI();
  const { notify } = useToast();
  const meeting = !!join.meeting;
  const remotes = useRemoteParticipants();
  const panel = useRef<HTMLDivElement | null>(null);
  const reloadRoster = roster.reload;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void reloadRoster();
  }, [open, reloadRoster]);

  // Start each opening fresh, adjusted during render on the open edge.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setBusy(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      // Leave button toggles open; ignore that click so we do not close-then-reopen.
      if ((e.target as HTMLElement).closest?.("[data-host-leave-trigger]")) return;
      if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, onClose, busy]);

  const coHosts = useMemo(
    () =>
      mergeHostCandidates(
        roster.live?.participants,
        remotes.map((p) => ({
          identity: p.identity,
          name: p.name || undefined,
          role: participantRole(p),
          canPublish: !!p.permissions?.canPublish,
          coHost: metadataCoHost(p.metadata),
        })),
        join.identity,
      ),
    [roster.live?.participants, remotes, join.identity],
  );

  if (!open) return null;

  const what = meeting ? "meeting" : "webinar";
  const items = leaveMenuItems(true, coHosts);

  async function handOver(identity: string, name: string) {
    setBusy(identity);
    setError(null);
    try {
      await api.transferHost(slug, identity);
      notify(`${name} is now the host. Leaving…`, "ok");
      onClose();
      leave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not hand over the host role.");
      setBusy(null);
    }
  }

  return (
    <div
      ref={panel}
      role="menu"
      aria-label="Leave options"
      className="room-dark absolute right-0 bottom-full z-50 mb-2 w-[min(19rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-2xl"
    >
      {error && (
        <p role="alert" className="mx-3.5 my-2 text-[12px] leading-relaxed text-live">
          {error}
        </p>
      )}
      {items.map((item) => {
        if (item.kind === "handover") {
          return (
            <button
              key={item.identity}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => void handOver(item.identity, item.name)}
              className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60 outline-none focus-visible:bg-surface-2"
            >
              <span className="inline-flex items-center gap-2 text-[13px] font-medium text-ink">
                {busy === item.identity && <Spinner className="size-3.5" />}
                {handoverLabel(item.name)}
              </span>
              <span className="text-[12px] leading-relaxed text-ink-2">
                They run the rest of the {what}. You leave as a panelist.
              </span>
            </button>
          );
        }
        if (item.kind === "leave") {
          return (
            <button
              key="leave"
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => {
                onClose();
                leave();
              }}
              className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-60 outline-none focus-visible:bg-surface-2"
            >
              <span className="text-[13px] font-medium text-ink">
                {meeting ? "Leave meeting" : "Leave webinar"}
              </span>
              <span className="text-[12px] leading-relaxed text-ink-2">
                {meeting
                  ? "Everyone else stays. Rejoin from Meetings while it's live. Without you or a co-host, nobody is let in from the lobby."
                  : "The stage carries on without a host. Rejoin from your dashboard while it's live."}{" "}
                {HOST_LEAVE_NO_COHOST_NOTE}
              </span>
            </button>
          );
        }
        return (
          <button
            key="end"
            type="button"
            role="menuitem"
            disabled={busy !== null}
            onClick={() => {
              onClose();
              onEnd();
            }}
            className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-live/10 disabled:opacity-60 outline-none focus-visible:bg-live/10"
          >
            <span className="text-[13px] font-medium text-live">
              {meeting ? "End meeting for everyone" : "End webinar for everyone"}
            </span>
            <span className="text-[12px] leading-relaxed text-ink-2">
              Disconnect everyone and mark the {what} as ended.
            </span>
          </button>
        );
      })}
      <div className="my-1 h-px bg-line" role="separator" />
      <button
        type="button"
        role="menuitem"
        disabled={busy !== null}
        onClick={onClose}
        className="flex w-full items-center px-3.5 py-2.5 text-left text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-60 outline-none focus-visible:bg-surface-2"
      >
        Cancel
      </button>
    </div>
  );
}
