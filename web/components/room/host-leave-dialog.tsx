"use client";

import { useRemoteParticipants } from "@livekit/components-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { mergeHostCandidates } from "@/lib/host-transfer";
import { Alert, ConfirmModal, Modal, Spinner } from "../controls";
import { useToast } from "../providers";
import { useRoomUI } from "./context";
import { participantRole } from "./participants";

export {
  eligibleHostCandidates,
  isEligibleHostCandidate,
  mergeHostCandidates,
} from "@/lib/host-transfer";

/**
 * Zoom-style Leave menu for the host: assign a successor, or end for everyone.
 * Anchored to the Leave button. Panelist pick and end-confirm stay in dialogs.
 */
export function HostLeaveMenu({
  open,
  onClose,
  onAssign,
  onEnd,
}: {
  open: boolean;
  onClose: () => void;
  onAssign: () => void;
  onEnd: () => void;
}) {
  const { join, roster } = useRoomUI();
  const remotes = useRemoteParticipants();
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    void roster.reload();
  }, [open, roster.reload]);

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

  const candidates = useMemo(
    () =>
      mergeHostCandidates(
        roster.live?.participants,
        remotes.map((p) => ({
          identity: p.identity,
          name: p.name || undefined,
          role: participantRole(p),
          canPublish: !!p.permissions?.canPublish,
        })),
        join.identity,
      ),
    [roster.live?.participants, remotes, join.identity],
  );

  if (!open) return null;

  return (
    <div
      ref={panel}
      role="menu"
      aria-label="Leave options"
      className="room-dark absolute right-0 bottom-full z-50 mb-2 w-[min(18rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-2xl"
    >
      <button
        type="button"
        role="menuitem"
        disabled={candidates.length === 0}
        onClick={() => {
          onClose();
          onAssign();
        }}
        className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45 outline-none focus-visible:bg-surface-2"
      >
        <span className="text-[13px] font-medium text-ink">Assign host & leave</span>
        <span className="text-[12px] leading-relaxed text-ink-2">
          {candidates.length === 0
            ? "No eligible panelist is in the room right now."
            : "Hand the session to another panelist, then exit."}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onEnd();
        }}
        className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-live/10 outline-none focus-visible:bg-live/10"
      >
        <span className="text-[13px] font-medium text-live">End webinar for everyone</span>
        <span className="text-[12px] leading-relaxed text-ink-2">
          Disconnect everyone and mark the webinar as ended.
        </span>
      </button>
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

/**
 * Second step after “Assign host & leave”: pick a panelist and confirm transfer.
 */
export function HostAssignDialog({
  open,
  onClose,
  onLeave,
}: {
  open: boolean;
  onClose: () => void;
  onLeave: () => void;
}) {
  const { slug, join, roster } = useRoomUI();
  const remotes = useRemoteParticipants();
  const { notify } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void roster.reload();
    setSelected(null);
    setError(null);
    setBusy(false);
  }, [open, roster.reload]);

  const candidates = useMemo(
    () =>
      mergeHostCandidates(
        roster.live?.participants,
        remotes.map((p) => ({
          identity: p.identity,
          name: p.name || undefined,
          role: participantRole(p),
          canPublish: !!p.permissions?.canPublish,
        })),
        join.identity,
      ),
    [roster.live?.participants, remotes, join.identity],
  );

  useEffect(() => {
    if (!open || selected) return;
    if (candidates[0]) setSelected(candidates[0].identity);
  }, [open, candidates, selected]);

  async function assignAndLeave() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.transferHost(slug, selected);
      notify("Host assigned. Leaving…", "ok");
      onLeave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign a new host.");
      setBusy(false);
    }
  }

  function resetAndClose() {
    if (busy) return;
    setSelected(null);
    setError(null);
    onClose();
  }

  if (!open) return null;

  return (
    <Modal
      dark
      open
      size="sm"
      onClose={resetAndClose}
      title="Assign host & leave"
      description="Choose a panelist to run the rest of the session. You will leave after they become host."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={resetAndClose}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void assignAndLeave()}
            disabled={busy || !selected}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-medium text-white hover:bg-brand/90 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {busy && <Spinner className="size-3.5" />}
            Assign & leave
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {candidates.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-ink-2">
          No panelists are in the room who can take over. Invite a panelist onto
          the stage first, or end the webinar for everyone instead.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {candidates.map((p) => {
            const active = selected === p.identity;
            return (
              <li key={p.identity}>
                <button
                  type="button"
                  onClick={() => setSelected(p.identity)}
                  disabled={busy}
                  aria-pressed={active}
                  className={`flex w-full items-center rounded-lg border px-3.5 py-3 text-left text-[13px] transition-colors disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    active
                      ? "border-brand bg-brand-soft text-brand"
                      : "border-line-2 text-ink hover:bg-surface-2"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {p.name || "Panelist"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/** Confirm ending the webinar for everyone (from the Leave menu). */
export function HostEndConfirm({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { slug } = useRoomUI();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  async function endForEveryone() {
    setBusy(true);
    try {
      await api.endWebinar(slug);
      onClose();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not end the webinar.", "error");
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      dark
      open={open}
      busy={busy}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      onConfirm={() => void endForEveryone()}
      title="End this webinar for everyone?"
      body="Everyone is disconnected and the webinar is marked as ended. Registrations and the attendance record are kept, but nobody can rejoin."
      confirmLabel="End for everyone"
    />
  );
}
