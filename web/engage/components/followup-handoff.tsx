"use client";

import { useState } from "react";
import { engageApi } from "../api";
import { useSession, useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { SendIcon } from "@/components/icons";
import type { CRMMergeField, CRMParam, CRMSegment } from "@/lib/api-types";
import { SendDialog, type SendTarget } from "./send-dialog";
import { WriteWordingDialog } from "./write-wording-dialog";

/* The follow-up writer's WhatsApp hand-off (components/followups-card.tsx). Nothing is sent
 * from the draft itself.
 *
 * A message to a group after a session is business-initiated and, for nearly everybody,
 * outside the 24-hour window, so Meta only delivers it as an approved template. So the
 * draft goes two ways, both the CRM's own:
 *   "Save as WhatsApp template"  the template wording dialog, with the draft filled in
 *                                ({{first_name}} as {{1}}): the host reviews it and submits
 *                                it to Meta.
 *   "Send to this group"         the send dialog, for this group of the webinar, where the
 *                                host picks an approved template (the one they saved, once
 *                                Meta has approved it) and sends or schedules.
 * Shown only to a host who has connected WhatsApp. */
export function FollowupWhatsAppActions({
  webinarId,
  groupLabel,
  wording,
  params,
  templateTitle,
  segment,
  contactIds,
}: {
  webinarId: string;
  groupLabel: string;
  /** The draft as template wording, {{1}} for the first name. */
  wording: string;
  params: CRMParam[];
  templateTitle: string;
  /** Who: a segment of the webinar, or exactly these contacts (the hot leads). */
  segment?: CRMSegment | null;
  contactIds?: string[];
}) {
  const { account } = useSession();
  const { notify } = useToast();
  const [writing, setWriting] = useState(false);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [target, setTarget] = useState<SendTarget | null>(null);
  if (!account?.whatsapp) return null;

  const openWording = () => {
    setWriting(true);
    engageApi
      .crmReminders()
      .then((r) => setFields(r.fields ?? []))
      .catch(() => undefined);
  };

  const hints = ["Pick the template you saved from this draft once Meta has approved it."];
  const openSend = () => {
    if (contactIds) {
      setTarget({ kind: "contacts", contactIds, webinarId, label: groupLabel, hints });
    } else {
      setTarget({ kind: "segment", webinarId, segment: segment ?? {}, label: groupLabel, hints });
    }
  };
  const canSend = contactIds ? contactIds.length > 0 : Boolean(segment);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={openWording} disabled={!wording.trim()}>
        Save as WhatsApp template
      </Button>
      {canSend && (
        <Button type="button" variant="secondary" size="sm" onClick={openSend}>
          <SendIcon className="size-3.5" />
          Send to this group
        </Button>
      )}
      {writing && (
        <WriteWordingDialog
          connected
          fields={fields}
          initialDraft={wording}
          initialMapping={params}
          initialTitle={templateTitle}
          onClose={() => setWriting(false)}
          onCreated={() => undefined}
          onUse={async () => {
            setWriting(false);
            notify("That wording is approved. Use it from Send to this group.", "ok");
            return true;
          }}
        />
      )}
      <SendDialog open={target !== null} target={target} onClose={() => setTarget(null)} />
    </>
  );
}
