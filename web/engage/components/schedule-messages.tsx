"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { engageApi } from "../api";
import { Alert, Modal } from "@/components/controls";
import { useSession, useToast } from "@/components/providers";
import { ApiError } from "@/lib/api";
import {
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  type CRMMergeField,
  type CRMRecipe,
  type CRMReminder,
  type CRMTemplate,
  type NotificationKind,
} from "@/lib/api-types";
import { automateFor } from "./automations";
import { exampleFor, renderTemplate } from "./crm-templates";
import { SendDialog } from "./send-dialog";
import { StarterTemplates } from "./starter-templates";
import { Switch } from "./wa-kit";
import { EVERYONE_MESSAGES, MessageEditor } from "./wa-messages";

/* Every message an attendee gets, shown while scheduling: the confirmation and
 * reminders before, the replay and each group's follow-up after — each with its
 * channels, the WhatsApp wording as they read it, and Edit.
 *
 * The WhatsApp wording and the follow-ups are account-wide (one set for every
 * webinar), and the box says so. Editors are portalled to <body>: this sits
 * inside the schedule <form>, whose submit their own buttons would trigger. */

type Stage = "before" | "after";

export function AttendeeMessages({
  stage,
  email,
  whatsapp,
  reminderLabel,
}: {
  stage: Stage;
  /** Whether email goes out for this stage's messages. */
  email: boolean;
  /** Whether the host switched WhatsApp on for this webinar's reminders. */
  whatsapp: boolean;
  /** "1 day, 1 hour before" — the reminder's when. */
  reminderLabel: string;
}) {
  const { account } = useSession();
  const { notify } = useToast();
  const connected = Boolean(account?.whatsapp?.connected);
  const [reminders, setReminders] = useState<CRMReminder[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [recipes, setRecipes] = useState<CRMRecipe[] | null>(null);
  const [editing, setEditing] = useState<NotificationKind | null>(null);
  const [writing, setWriting] = useState(false);
  const [followup, setFollowup] = useState<CRMRecipe | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    Promise.all([
      engageApi.crmReminders(),
      engageApi.crmTemplates(),
      stage === "after" ? engageApi.crmRecipes() : Promise.resolve(null),
    ])
      .then(([r, t, rc]) => {
        if (cancelled) return;
        setReminders(r.reminders);
        setFields(r.fields);
        setTemplates(t.templates);
        if (rc) setRecipes(rc.recipes.filter((x) => x.kind === "followup"));
      })
      .catch(() => !cancelled && setTemplates([]));
    return () => {
      cancelled = true;
    };
  }, [connected, stage, tick]);

  const templateFor = (name?: string, language?: string) =>
    (templates ?? []).find((x) => x.name === name && x.language === language);

  function reminderRow(kind: NotificationKind, whenText: string) {
    const m = EVERYONE_MESSAGES.find((x) => x.kind === kind)!;
    const r = reminders?.find((x) => x.kind === kind);
    const t = templateFor(r?.template, r?.language);
    const wa = connected && (kind === NotifyWhatsAppReplay || whatsapp);
    return (
      <Row
        key={kind}
        title={m.title}
        when={whenText}
        channels={[email && "Email", wa && t && "WhatsApp"]}
        preview={
          wa ? (
            t ? (
              <Bubble
                template={t}
                values={(r?.params ?? []).map((p) => exampleFor(fields, p))}
              />
            ) : (
              <Muted>
                {templates === null
                  ? "…"
                  : "No WhatsApp wording yet — email only."}
              </Muted>
            )
          ) : null
        }
        action={
          wa ? (
            <TextButton onClick={() => setEditing(kind)} disabled={!templates}>
              {t ? "Edit" : "Set up"}
            </TextButton>
          ) : null
        }
      />
    );
  }

  async function toggle(r: CRMRecipe, on: boolean) {
    if (on && !(r.configured && r.template)) {
      setFollowup(r);
      return;
    }
    try {
      const res = await engageApi.saveCrmRecipe(r.id, {
        active: on,
        template: on ? r.template : undefined,
        language: on ? r.language : undefined,
        params: on ? r.params : undefined,
        delayMin: on ? r.delayMin : undefined,
      });
      setRecipes(res.recipes.filter((x) => x.kind === "followup"));
      notify(on ? "On for every webinar." : "Off.", "ok");
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not change that.",
        "error",
      );
    }
  }

  const rows: ReactNode[] =
    stage === "before"
      ? [
          reminderRow(NotifyWhatsAppConfirmed, "when they register"),
          reminderRow(NotifyWhatsAppReminder, reminderLabel),
        ]
      : [
          reminderRow(NotifyWhatsAppReplay, "when you publish the recording"),
          ...(connected
            ? (recipes ?? []).map((r) => {
                const t = r.template
                  ? templateFor(r.template, r.language)
                  : undefined;
                return (
                  <Row
                    key={r.id}
                    title={r.title}
                    when={r.flow[1] ?? ""}
                    channels={[r.active && "WhatsApp"]}
                    preview={
                      t ? (
                        <Bubble
                          template={t}
                          values={(r.params ?? []).map((p) =>
                            p.field
                              ? exampleFor(fields, p.field)
                              : (p.text ?? ""),
                          )}
                          dim={!r.active}
                        />
                      ) : (
                        <Muted>
                          Not set up — you can still message them from Follow up
                          after.
                        </Muted>
                      )
                    }
                    action={
                      <div className="flex items-center gap-3">
                        <TextButton
                          onClick={() => setFollowup(r)}
                          disabled={!templates}
                        >
                          {r.configured && r.template ? "Edit" : "Set up"}
                        </TextButton>
                        <Switch
                          checked={r.active}
                          onChange={(on) => void toggle(r, on)}
                          label={`${r.title} after every webinar`}
                        />
                      </div>
                    }
                  />
                );
              })
            : []),
        ];

  const editingMeta = EVERYONE_MESSAGES.find((x) => x.kind === editing);
  const auto = followup ? automateFor(followup) : null;

  return (
    <div className="grid gap-2">
      <div className="divide-y divide-line rounded-xl border border-line">
        {rows}
      </div>
      {stage === "after" && connected && recipes === null && <Muted>…</Muted>}
      {connected && (
        <p className="text-[11.5px] text-ink-3">
          WhatsApp wording and follow-ups are the same for all your webinars ·{" "}
          <Link href="/host/crm" className="text-brand hover:underline">
            WhatsApp page
          </Link>
        </p>
      )}

      {editingMeta &&
        templates &&
        createPortal(
          <MessageEditor
            kind={editingMeta.kind}
            title={editingMeta.title}
            current={reminders?.find((r) => r.kind === editingMeta.kind)}
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
      {auto &&
        createPortal(
          <SendDialog
            open
            target={auto.target}
            automate={auto.automate}
            onClose={() => setFollowup(null)}
            onSent={refresh}
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
              <StarterTemplates connected={connected} onCreated={refresh} />
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
}

/** One message in the list: what, when, by which channels, and how it reads. */
export function Row({
  title,
  when,
  channels,
  preview,
  action,
}: {
  title: string;
  when: string;
  channels: (string | false | null | undefined)[];
  preview?: ReactNode;
  action?: ReactNode;
}) {
  const on = channels.filter(Boolean) as string[];
  return (
    <div className="grid gap-2 px-3.5 py-3 md:grid-cols-[13rem_minmax(0,1fr)_auto] md:items-start md:gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p className="text-[11.5px] text-ink-3">{when}</p>
        <p className="mt-1 flex flex-wrap gap-1">
          {on.length ? (
            on.map((c) => (
              <span
                key={c}
                className="rounded bg-surface-2 px-1.5 py-px text-[10.5px] font-semibold text-ink-2"
              >
                {c}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-ink-3">Off</span>
          )}
        </p>
      </div>
      <div className="min-w-0">{preview}</div>
      {action ? <div className="md:pt-0.5">{action}</div> : <span />}
    </div>
  );
}

function Bubble({
  template,
  values,
  dim,
}: {
  template: CRMTemplate;
  values: string[];
  dim?: boolean;
}) {
  return (
    <div className={`rounded-lg bg-[#efeae2] p-1.5 ${dim ? "opacity-60" : ""}`}>
      <div className="rounded-md rounded-tl-none bg-white px-2 py-1.5 text-[12px] leading-relaxed text-[#111] shadow-sm">
        {renderTemplate(template.body ?? "", values)}
        {(template.buttons ?? []).length > 0 && (
          <span className="mt-1 flex justify-center gap-4 border-t border-black/5 pt-1 text-[11.5px] font-medium text-[#027eb5]">
            {template.buttons.map((b) => (
              <span key={b.text}>
                {b.type === "URL" ? "↗" : "↩"} {b.text}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-ink-3">{children}</p>;
}

function TextButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[12.5px] font-medium text-brand hover:underline disabled:opacity-50"
    >
      {children}
    </button>
  );
}
