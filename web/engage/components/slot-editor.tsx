"use client";

import { useState } from "react";
import { Alert, Modal, Spinner } from "@/components/controls";
import { Button } from "@/components/ui";
import {
  ChannelWhatsApp,
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  SlotConfirmation,
  SlotReminder,
  type CRMMergeField,
  type CRMTemplate,
  type MessageSlot,
  type NotificationKind,
} from "@/lib/api-types";
import { exampleFor, renderTemplate, templateKey } from "./crm-templates";
import { categoryWords, guessParams } from "./wa-messages";
import { timingForSave } from "./message-timing";

function guessKind(kind: string): NotificationKind {
  if (kind === SlotConfirmation) return NotifyWhatsAppConfirmed;
  if (kind === SlotReminder) return NotifyWhatsAppReminder;
  return NotifyWhatsAppReplay;
}

/* Pick the approved wording for one account default. Saves through the caller,
 * which writes /crm/message-defaults and nothing else. */
export function SlotEditor({
  slot,
  title,
  templates,
  fields,
  busy,
  error,
  onClose,
  onSave,
  onWriteOwn,
}: {
  slot: MessageSlot;
  title: string;
  templates: CRMTemplate[];
  fields: CRMMergeField[];
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (slot: MessageSlot) => void;
  onWriteOwn: () => void;
}) {
  const usable = templates.filter((t) => t.sendable);
  const initial = usable.find(
    (t) => t.name === slot.template && t.language === slot.language,
  );
  const [chosen, setChosen] = useState(initial ? templateKey(initial) : "");
  const [params, setParams] = useState<string[]>(slot.params ?? []);
  const template = usable.find((t) => templateKey(t) === chosen);

  function pick(t: CRMTemplate) {
    setChosen(templateKey(t));
    setParams(guessParams(t, guessKind(slot.kind), fields));
  }

  function save() {
    if (!template) return;
    const channels = slot.channels.includes(ChannelWhatsApp)
      ? slot.channels
      : [...slot.channels, ChannelWhatsApp];
    onSave({
      ...slot,
      channels,
      timing: timingForSave(slot.timing),
      template: template.name,
      language: template.language,
      params,
      enabled: true,
    });
  }

  const preview = template
    ? renderTemplate(
        template.body ?? "",
        params.map((p) => exampleFor(fields, p)),
      )
    : "";

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Edit ${title}`}
      description="This wording is the default for every new webinar. You can still change one webinar while scheduling."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!template || busy}>
            {busy && <Spinner className="size-3.5" />}
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <Alert tone="error">{error}</Alert>}
        {usable.length === 0 ? (
          <p className="text-[13px] text-ink-2">
            No approved wording yet. Write your own and Meta reviews it, usually in minutes.
          </p>
        ) : (
          <ul className="grid max-h-64 gap-1.5 overflow-auto">
            {usable.map((t) => {
              const on = templateKey(t) === chosen;
              return (
                <li key={templateKey(t)}>
                  <button
                    type="button"
                    onClick={() => pick(t)}
                    className={`w-full rounded-lg border px-3 py-2 text-left ${
                      on ? "border-brand bg-brand-soft" : "border-line hover:border-line-2"
                    }`}
                  >
                    <span className="block text-[13px] font-medium text-ink">
                      {t.name.replace(/[_-]+/g, " ")}
                    </span>
                    <span className="text-[11.5px] text-ink-3">
                      {categoryWords(t.category)}
                      {t.language ? ` · ${t.language}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {preview && (
          <div className="rounded-lg rounded-bl-sm bg-[#eef6ea] px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-2 italic">
            “{preview}”
          </div>
        )}
        <button
          type="button"
          onClick={onWriteOwn}
          className="justify-self-start text-[12.5px] font-medium text-brand hover:underline"
        >
          + Write your own
        </button>
      </div>
    </Modal>
  );
}
