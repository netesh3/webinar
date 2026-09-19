"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "../ui";
import { useRoomUI } from "./context";

export function StageInviteDialog({ onAccepted }: { onAccepted?: () => void }) {
  const { slug, joinKey, realtime, recording } = useRoomUI();
  const invite = realtime.stageInvite;
  const [busy, setBusy] = useState(false);

  if (!invite) return null;

  async function respond(accept: boolean) {
    setBusy(true);
    try {
      await api.respondStageInvite(slug, { joinKey, accept });
      realtime.dismissStageInvite();
      if (accept) onAccepted?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stage-invite-title"
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-4 shadow-2xl">
        <h2 id="stage-invite-title" className="text-[16px] font-semibold text-ink">
          Join the stage?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          The host invited you to {invite.audioOnly ? "speak" : "appear on camera"}.
          You will be visible and heard by the audience.
          {(invite.recording || recording) &&
            " This session is being recorded."}
        </p>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void respond(false)}
          >
            Stay as attendee
          </Button>
          <Button type="button" disabled={busy} onClick={() => void respond(true)}>
            Join stage
          </Button>
        </div>
      </div>
    </div>
  );
}
