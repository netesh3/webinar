"use client";

import { useState } from "react";
import { engageApi } from "../api";
import { Alert, Modal, Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  ChannelWhatsApp,
  type CRMMergeField,
  type CRMStarterTemplate,
  type CRMTemplate,
  type MessageSlot,
} from "@/lib/api-types";
import { guessParams } from "./wa-messages";
import { timingForSave } from "./message-timing";
import { isFollowup, wordingKind } from "./messages/catalog";
import { StarterTemplates } from "./starter-templates";

/* The "Write your own wording" dialog opened from a message in Setup. The
 * WhatsApp page uses the wording drawer instead. The templates library uses
 * StarterTemplates on its own and does not come through here.
 *
 * An approved starter is applied to the message that opened the dialog. A
 * starter Meta has not seen yet is submitted. Anything the host types is
 * submitted as their own template, unless it is one of those approved starters. */

const MAX_BODY = 1024;

export function templateForStarter(
  templates: CRMTemplate[],
  starter: CRMStarterTemplate,
): CRMTemplate | undefined {
  const named = templates.filter((t) => t.name === starter.name);
  return (
    named.find((t) => t.language === "en" && t.sendable) ??
    named.find((t) => t.sendable) ??
    named.find((t) => t.language === "en") ??
    named[0]
  );
}

/** The template to save on the message, refreshing from Meta when the list is stale. */
export async function resolveStarterTemplate(
  starter: CRMStarterTemplate,
  templates: CRMTemplate[],
): Promise<{ template: CRMTemplate; templates: CRMTemplate[] } | null> {
  const known = templateForStarter(templates, starter);
  if (known?.sendable) return { template: known, templates };
  try {
    const fresh = await engageApi.crmTemplates(true);
    const list = fresh.templates ?? [];
    const next = templateForStarter(list, starter);
    if (!next) return null;
    return { template: next, templates: list };
  } catch {
    return known ? { template: known, templates } : null;
  }
}

export function slotWithWording(
  slot: MessageSlot,
  starter: CRMStarterTemplate,
  template: CRMTemplate,
  fields: CRMMergeField[],
): MessageSlot {
  const params =
    starter.params.length === template.variables
      ? starter.params
      : guessParams(template, wordingKind(slot.kind), fields);
  return {
    ...slot,
    template: template.name,
    language: template.language,
    params,
    enabled: isFollowup(slot.kind) ? true : slot.enabled,
  };
}

/** The account-default save the message editor writes: WhatsApp on, timing in
 * the shape the API stores, and this approved template's blanks filled in. */
export function slotFromTemplate(
  slot: MessageSlot,
  template: CRMTemplate,
  fields: CRMMergeField[],
): MessageSlot {
  const channels = slot.channels.includes(ChannelWhatsApp)
    ? slot.channels
    : [...slot.channels, ChannelWhatsApp];
  return {
    ...slot,
    channels,
    timing: timingForSave(slot.timing),
    template: template.name,
    language: template.language,
    params: guessParams(template, wordingKind(slot.kind), fields),
    enabled: true,
  };
}

function sameBody(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

export function WriteWordingDialog({
  connected,
  onClose,
  onCreated,
  onUse,
}: {
  connected: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Apply this wording to the message that opened the dialog. Resolve false to keep it open. */
  onUse: (template: CRMStarterTemplate) => Promise<boolean>;
}) {
  const { notify } = useToast();
  const [starters, setStarters] = useState<CRMStarterTemplate[] | null>(null);
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const ready = Boolean(
    starters?.length && starters.every((t) => t.status === "APPROVED" && !t.error),
  );
  const typed = draft.trim();
  const match = starters?.find(
    (t) => t.status === "APPROVED" && !t.error && sameBody(t.body, typed),
  );

  async function submitOwn() {
    if (!typed || busy) return;
    if (match) {
      await onUse(match);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const saved = await engageApi.createCrmWording({ body: typed, category });
      onCreated();
      if (saved.status === "APPROVED") {
        await onUse({
          name: saved.name,
          category: saved.category,
          use: "Your wording",
          body: saved.body,
          params: [],
          examples: [],
          buttons: [],
          status: "APPROVED",
        });
        return;
      }
      setDraft("");
      setNote(
        "Submitted to Meta. You can use it on this message once it is approved, usually in a few minutes.",
      );
      notify("Submitted to Meta. Approval usually takes a few minutes.", "ok");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not submit that wording.";
      setNote(msg);
      notify(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title="Create Template">
      <div className="grid gap-3">
        <Alert tone="info">
          {ready
            ? "These starters are approved. Use one on this message, or type your own wording below. Meta reviews new wording, usually in minutes."
            : "Meta approves every message before it can be sent, usually in minutes. Submit a starter to use it, or type your own wording below."}
        </Alert>
        <StarterTemplates
          connected={connected}
          onCreated={onCreated}
          onUse={onUse}
          onItems={setStarters}
        />
        <form
          className="grid gap-2 rounded-xl border border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitOwn();
          }}
        >
          <div>
            <h3 className="text-[15px] font-semibold">Write your own</h3>
            <p className="mt-0.5 text-[12.5px] text-ink-2">
              Type the message. Use {"{{1}}"}, {"{{2}}"} for the parts that change,
              such as a name or the webinar.
            </p>
          </div>
          <textarea
            className="field min-h-24 resize-y py-2"
            value={draft}
            maxLength={MAX_BODY}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Hi {{1}}, you're registered for {{2}}."
            aria-label="Your wording"
          />
          {!match && (
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
              Kind
              <select
                className="field h-8 w-auto"
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value === "MARKETING" ? "MARKETING" : "UTILITY")
                }
                aria-label="Wording kind"
              >
                <option value="UTILITY">Utility</option>
                <option value="MARKETING">Marketing</option>
              </select>
            </label>
          )}
          {note && <p className="text-[12.5px] text-ink-2">{note}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={busy || !typed}>
              {busy && <Spinner className="size-3.5" />}
              {match ? "Use this wording" : "Submit wording"}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
