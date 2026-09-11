"use client";

import { useRemoteParticipants } from "@livekit/components-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { LiveParticipant } from "@/lib/api-types";
import { Alert, ConfirmModal, Modal, Spinner } from "../controls";
import { useToast } from "../providers";
import { useRoomUI } from "./context";
import { participantRole } from "./participants";

/** Panelists (signed-in stage seats) who can take over as host. */
export function eligibleHostCandidates(
  participants: LiveParticipant[] | null | undefined,
  selfIdentity: string,
): LiveParticipant[] {
  if (!participants) return [];
  return participants.filter(
    (p) =>
      p.identity !== selfIdentity &&
      p.identity.startsWith("user_") &&
      p.role === "panelist" &&
      p.canPublish,
  );
}

type Step = "choose" | "pick" | "confirm-end";

/**
 * Host Leave flow: assign another panelist and leave, or end for everyone.
 * Attendees and panelists never see this — their Leave still exits immediately.
 */
export function HostLeaveDialog({
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
  const [step, setStep] = useState<Step>("choose");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void roster.reload();
  }, [open, roster.reload]);

  const candidates = useMemo(() => {
    const fromRoster = eligibleHostCandidates(roster.live?.participants, join.identity);
    if (fromRoster.length > 0) return fromRoster;
    // Roster poll can lag a few seconds; the SFU client list already has every
    // panelist the host can see, which is enough to pick a successor.
    return remotes
      .filter(
        (p) =>
          p.identity !== join.identity &&
          p.identity.startsWith("user_") &&
          participantRole(p) === "panelist" &&
          !!p.permissions?.canPublish,
      )
      .map(
        (p): LiveParticipant => ({
          identity: p.identity,
          name: p.name || "Panelist",
          role: "panelist",
          joinedAt: "",
          publishing: [],
          audioMuted: true,
          hidden: false,
          canPublish: true,
          canSpeak: true,
          audioOnly: false,
          mutedByHost: false,
        }),
      );
  }, [roster.live?.participants, remotes, join.identity]);

  function resetAndClose() {
    if (busy) return;
    setStep("choose");
    setSelected(null);
    setError(null);
    onClose();
  }

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

  async function endForEveryone() {
    setBusy(true);
    setError(null);
    try {
      await api.endWebinar(slug);
      setStep("choose");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end the webinar.");
      setBusy(false);
    }
  }

  if (!open) return null;

  if (step === "confirm-end") {
    return (
      <ConfirmModal
        dark
        open
        busy={busy}
        onClose={() => {
          if (busy) return;
          setError(null);
          setStep("choose");
        }}
        onConfirm={() => void endForEveryone()}
        title="End this webinar for everyone?"
        body="Everyone is disconnected and the webinar is marked as ended. Registrations and the attendance record are kept, but nobody can rejoin."
        confirmLabel="End for everyone"
      />
    );
  }

  if (step === "pick") {
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
              onClick={() => {
                setError(null);
                setStep("choose");
              }}
              disabled={busy}
              className="rounded-lg px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Back
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

  return (
    <Modal
      dark
      open
      size="sm"
      onClose={resetAndClose}
      title="Leave webinar"
      description="You are the host. Choose what should happen when you leave."
      footer={
        <div className="flex justify-end">
          <button
            type="button"
            onClick={resetAndClose}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            Cancel
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setSelected(candidates[0]?.identity ?? null);
            setStep("pick");
          }}
          disabled={busy || candidates.length === 0}
          className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
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
          onClick={() => {
            setError(null);
            setStep("confirm-end");
          }}
          disabled={busy}
          className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-live/30 bg-live/10 px-3.5 py-3 text-left transition-colors hover:bg-live/15 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-live/40"
        >
          <span className="text-[13px] font-medium text-live">End webinar for everyone</span>
          <span className="text-[12px] leading-relaxed text-ink-2">
            Disconnect everyone and mark the webinar as ended.
          </span>
        </button>
      </div>
    </Modal>
  );
}
