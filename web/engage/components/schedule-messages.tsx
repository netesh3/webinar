"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { engageApi } from "../api";
import { Alert, Modal } from "@/components/controls";
import { useSession } from "@/components/providers";
import {
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  type CRMMergeField,
  type CRMReminder,
  type CRMTemplate,
} from "@/lib/api-types";
import { exampleFor, renderTemplate } from "./crm-templates";
import { StarterTemplates } from "./starter-templates";
import { EVERYONE_MESSAGES, MessageEditor } from "./wa-messages";

/* What goes out on WhatsApp, shown right under the reminder switches while
 * scheduling: the confirmation and the reminder as the attendee reads them,
 * each with Edit. The wording is account-wide (one set for every webinar), so
 * editing here is the same edit as on the WhatsApp page — said so, not hidden.
 *
 * The editor is portalled to <body>: this sits inside the schedule <form>, and
 * the editor's own buttons would otherwise submit it. */

const SHOWN = EVERYONE_MESSAGES.filter((m) => m.kind !== NotifyWhatsAppReplay);

export function ScheduleWhatsAppMessages({
  reminderLabel,
}: {
  reminderLabel: string;
}) {
  const { account } = useSession();
  const connected = Boolean(account?.whatsapp?.connected);
  const [reminders, setReminders] = useState<CRMReminder[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [editing, setEditing] = useState<(typeof SHOWN)[number] | null>(null);
  const [writing, setWriting] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    Promise.all([engageApi.crmReminders(), engageApi.crmTemplates()])
      .then(([r, t]) => {
        if (cancelled) return;
        setReminders(r.reminders);
        setFields(r.fields);
        setTemplates(t.templates);
      })
      .catch(() => !cancelled && setTemplates([]));
    return () => {
      cancelled = true;
    };
  }, [connected, tick]);

  if (!connected) return null;

  return (
    <div className="rounded-xl border border-line bg-surface-2/50 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[12.5px] font-medium text-ink">
          What they get on WhatsApp
        </p>
        <p className="text-[11.5px] text-ink-3">
          Same wording for all your webinars ·{" "}
          <Link href="/host/crm" className="text-brand hover:underline">
            WhatsApp page
          </Link>
        </p>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {SHOWN.map((m) => {
          const r = reminders?.find((x) => x.kind === m.kind);
          const t = (templates ?? []).find(
            (x) => x.name === r?.template && x.language === r?.language,
          );
          return (
            <div
              key={m.kind}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12.5px] font-semibold text-ink">
                  {m.title}{" "}
                  <span className="font-normal text-ink-3">
                    ·{" "}
                    {m.kind === NotifyWhatsAppReminder
                      ? reminderLabel
                      : "when they register"}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setEditing(m)}
                  disabled={!templates}
                  className="shrink-0 text-[12px] font-medium text-brand hover:underline disabled:opacity-50"
                >
                  {t ? "Edit" : "Set up"}
                </button>
              </div>
              <div className="flex-1 rounded-lg bg-[#efeae2] p-1.5">
                {t ? (
                  <div className="rounded-md rounded-tl-none bg-white px-2 py-1.5 text-[12px] leading-relaxed text-[#111] shadow-sm">
                    {renderTemplate(
                      t.body ?? "",
                      (r?.params ?? []).map((p) => exampleFor(fields, p)),
                    )}
                    {(t.buttons ?? []).length > 0 && (
                      <span className="mt-1 flex justify-center gap-4 border-t border-black/5 pt-1 text-[11.5px] font-medium text-[#027eb5]">
                        {t.buttons.map((b) => (
                          <span key={b.text}>
                            {b.type === "URL" ? "↗" : "↩"} {b.text}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="px-1.5 py-1 text-[12px] text-ink-3">
                    {templates === null
                      ? "…"
                      : "Not set — this one goes by email only."}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing &&
        templates &&
        createPortal(
          <MessageEditor
            kind={editing.kind}
            title={editing.title}
            current={reminders?.find((r) => r.kind === editing.kind)}
            templates={templates}
            fields={fields}
            onClose={() => setEditing(null)}
            onSaved={(all) => setReminders(all)}
            onWriteOwn={() => {
              setEditing(null);
              setWriting(true);
            }}
          />,
          document.body,
        )}
      {writing &&
        createPortal(
          <Modal
            open
            onClose={() => setWriting(false)}
            size="lg"
            title="Write your own wording"
          >
            <div className="grid gap-3">
              <Alert tone="info">
                Meta approves every message before it can be sent, usually in
                minutes. Start from these, written for webinars.
              </Alert>
              <StarterTemplates
                connected={connected}
                onCreated={() => setTick((n) => n + 1)}
              />
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
}
