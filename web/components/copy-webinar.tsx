"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Modal, Spinner } from "./controls";
import { useToast } from "./providers";
import { Button } from "./ui";

/* The confirm step for "Copy webinar". The copy is a draft owned by the same host
 * (api handleCopyWebinar); on success the editor opens on it so the host can pick
 * the date and schedule it. */
export function CopyWebinarDialog({
  webinar,
  onClose,
}: {
  webinar: { id: string; topic: string } | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (!webinar) return;
    setBusy(true);
    try {
      const draft = await api.copyWebinar(webinar.id);
      notify("Draft copy created — pick a date and schedule it.", "ok");
      router.push(`/host/${encodeURIComponent(draft.id)}/edit`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not copy that webinar.", "error");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={webinar !== null}
      onClose={() => !busy && onClose()}
      title="Copy this webinar?"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void copy()} disabled={busy}>
            {busy && <Spinner className="size-3.5" />}
            Copy as draft
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        Creates a draft copy of “{webinar?.topic}” with the same details, questions,
        polls, panelists and messages. Registrants and recordings aren&apos;t copied, and
        nobody is emailed until you schedule it.
      </p>
    </Modal>
  );
}
