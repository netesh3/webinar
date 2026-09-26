"use client";

import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Alert, Modal, Select, Spinner, openPickerOnClick } from "@/components/controls";
import { SendIcon } from "@/components/icons";
import { useSession, useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  AudienceContacts,
  AudienceSegment,
  NotifyWhatsAppReplay,
  NotifyWhatsAppReminder,
  type CRMAudienceResponse,
  type CRMBroadcastRequest,
  type CRMMergeField,
  type CRMParam,
  type CRMSegment,
  type CRMTemplate,
} from "@/lib/api-types";
import { localTimeZone, zonedToInstant } from "@/lib/format";
import { exampleFor, renderTemplate, templateKey } from "./crm-templates";

/* The one send dialog: "Message these N" from the Attendees tab, the People tab, and a
 * webinar's Messages tab all open this.
 *
 * Who is fixed by the caller — a watch-time bucket of one webinar, or people ticked by
 * hand — and shown at the top with its real count from the server. The rest is the
 * broadcast form cut to what a follow-up needs: a template, its values, now or later,
 * a preview, and a test to your own phone.
 */

export type SendTarget =
  | { kind: "segment"; webinarId: string; segment: CRMSegment; label: string }
  | { kind: "contacts"; contactIds: string[]; webinarId?: string; label: string };

const LITERAL = "\u0000text";

export function SendDialog({
  open,
  target,
  onClose,
  onSent,
}: {
  open: boolean;
  target: SendTarget | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  if (!open || !target) return null;
  return <SendDialogBody target={target} onClose={onClose} onSent={onSent} />;
}

function audienceBody(target: SendTarget): CRMBroadcastRequest {
  return target.kind === "segment"
    ? {
        name: "",
        template: "",
        language: "",
        audience: AudienceSegment,
        webinarId: target.webinarId,
        segment: target.segment,
      }
    : {
        name: "",
        template: "",
        language: "",
        audience: AudienceContacts,
        contactIds: target.contactIds,
        webinarId: target.webinarId,
      };
}

function SendDialogBody({
  target,
  onClose,
  onSent,
}: {
  target: SendTarget;
  onClose: () => void;
  onSent?: () => void;
}) {
  const { notify } = useToast();
  const { account } = useSession();
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [audience, setAudience] = useState<CRMAudienceResponse | null>(null);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [params, setParams] = useState<CRMParam[]>([]);
  const [timing, setTiming] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = Boolean(account?.whatsapp?.connected);

  useEffect(() => {
    let cancelled = false;
    Promise.all([engageApi.crmTemplates(), engageApi.crmBroadcasts()])
      .then(([t, b]) => {
        if (cancelled) return;
        setTemplates(t.templates.filter((x) => x.sendable));
        // Fields that only mean something on an automatic message are not offered.
        setFields(
          b.fields.filter(
            (f) =>
              !f.onlyKind ||
              (f.onlyKind !== NotifyWhatsAppReplay && f.onlyKind !== NotifyWhatsAppReminder),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    engageApi
      .crmAudienceFor(audienceBody(target))
      .then((a) => {
        if (!cancelled) setAudience(a);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setAudienceError(e instanceof ApiError ? e.message : "Could not count these people.");
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const template = (templates ?? []).find((t) => templateKey(t) === chosen);
  const hasWebinar = Boolean(target.webinarId);
  const offered = fields.filter(
    (f) => hasWebinar || !["topic", "when", "watched"].includes(f.token),
  );

  function pick(key: string) {
    setChosen(key);
    const t = (templates ?? []).find((x) => templateKey(x) === key);
    const order = ["first_name", "topic", "when", "host"].filter((tok) =>
      offered.some((f) => f.token === tok),
    );
    setParams(
      t
        ? Array.from({ length: t.variables }, (_, i) =>
            order[i] ? { field: order[i] } : { text: "" },
          )
        : [],
    );
  }

  const filled = params.map((p) => (p.field ? exampleFor(fields, p.field) : (p.text ?? "")));
  const scheduledAt =
    timing === "later" && at ? zonedToInstant(at.slice(0, 10), at.slice(11, 16), localTimeZone()) : null;

  const blocker = !connected
    ? "Connect WhatsApp in Account settings to send."
    : !template
      ? "Pick a template."
      : params.some((p) => !p.field && !(p.text ?? "").trim())
        ? "Fill every {{n}} — WhatsApp rejects a message with a blank in it."
        : timing === "later" && !scheduledAt
          ? "Pick when to send it."
          : audience && audience.recipients === 0
            ? "None of these people can be messaged on WhatsApp."
            : null;

  function request(): CRMBroadcastRequest {
    return {
      ...audienceBody(target),
      name: target.label,
      template: template?.name ?? "",
      language: template?.language ?? "",
      params,
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : undefined,
    };
  }

  async function send() {
    if (blocker || !template) return;
    setSaving(true);
    try {
      const b = await engageApi.createCrmBroadcast(request());
      notify(
        scheduledAt
          ? `Scheduled for ${b.stats.recipients} ${b.stats.recipients === 1 ? "person" : "people"}.`
          : `Sending to ${b.stats.recipients} ${b.stats.recipients === 1 ? "person" : "people"}.`,
        "ok",
      );
      onSent?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : "Could not send that.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!template) return;
    setTesting(true);
    try {
      await engageApi.crmTestSend({
        template: template.name,
        language: template.language,
        params,
        webinarId: target.webinarId,
        phone: testPhone,
      });
      notify("Test sent to your phone.", "ok");
    } catch (e: unknown) {
      notify(e instanceof ApiError ? e.message : "Could not send the test.", "error");
    } finally {
      setTesting(false);
    }
  }

  const reach = audience?.recipients ?? 0;
  const left = audience ? audience.noOptIn + audience.optedOut + audience.noNumber : 0;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Message ${target.label.toLowerCase()}`}
      description="Sent on WhatsApp from your number, billed to your Meta account."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={send} disabled={saving || blocker !== null}>
            {saving ? <Spinner className="size-3.5" /> : <SendIcon className="size-3.5" />}
            {timing === "later" ? "Schedule" : `Send to ${reach}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="error">{error}</Alert>}

        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[12.5px]">
          <div className="font-medium text-ink">To: {target.label}</div>
          <div className="mt-0.5 text-ink-2">
            {audienceError ? (
              audienceError
            ) : audience === null ? (
              "Counting…"
            ) : (
              <>
                <span className="font-medium text-ok">{reach} will get it</span>
                {left > 0 && (
                  <>
                    {" · "}
                    {left} can&apos;t be messaged (
                    {[
                      audience.noOptIn && `${audience.noOptIn} didn't opt in`,
                      audience.optedOut && `${audience.optedOut} opted out`,
                      audience.noNumber && `${audience.noNumber} no number`,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    )
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {templates === null ? (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Spinner className="size-4" /> Loading templates…
          </div>
        ) : templates.length === 0 ? (
          <Alert tone="warn">
            No approved templates yet. WhatsApp only lets you message people who haven&apos;t
            written to you with a template Meta has approved — create one in WhatsApp Manager.
          </Alert>
        ) : (
          <Select label="Template" value={chosen} onChange={pick}>
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={templateKey(t)} value={templateKey(t)}>
                {t.name} · {t.language} · {t.category.toLowerCase()}
              </option>
            ))}
          </Select>
        )}

        {template && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid content-start gap-2">
              {params.map((p, i) => (
                <div key={i} className="grid gap-1.5">
                  <Select
                    label={`{{${i + 1}}}`}
                    value={p.field || LITERAL}
                    onChange={(next) =>
                      setParams((prev) =>
                        prev.map((q, j) =>
                          j === i ? (next === LITERAL ? { text: "" } : { field: next }) : q,
                        ),
                      )
                    }
                  >
                    {offered.map((f) => (
                      <option key={f.token} value={f.token}>
                        {f.label}
                      </option>
                    ))}
                    <option value={LITERAL}>Type the words</option>
                  </Select>
                  {!p.field && (
                    <input
                      className="field"
                      aria-label={`What {{${i + 1}}} says`}
                      value={p.text ?? ""}
                      onChange={(e) =>
                        setParams((prev) =>
                          prev.map((q, j) => (j === i ? { text: e.target.value } : q)),
                        )
                      }
                    />
                  )}
                </div>
              ))}
              {params.length === 0 && (
                <p className="text-[12px] text-ink-3">This template has nothing to fill in.</p>
              )}
            </div>
            <div>
              <span className="label">Preview</span>
              <div className="rounded-2xl rounded-tl-sm border border-line bg-[#e7f7e1] px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
                {template.header && <p className="font-semibold">{template.header}</p>}
                {renderTemplate(template.body ?? "", filled)}
                {template.footer && (
                  <p className="mt-1 text-[11px] text-ink-3">{template.footer}</p>
                )}
              </div>
            </div>
          </div>
        )}

        <fieldset className="grid gap-2">
          <legend className="label">When</legend>
          <div className="flex flex-wrap items-center gap-4 text-[13px]">
            {(["now", "later"] as const).map((t) => (
              <label key={t} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="send-timing"
                  className="size-4 accent-brand"
                  checked={timing === t}
                  onChange={() => setTiming(t)}
                />
                {t === "now" ? "Send now" : "Schedule"}
              </label>
            ))}
            {timing === "later" && (
              <input
                type="datetime-local"
                aria-label="When to send it"
                onClick={openPickerOnClick}
                className="field h-9 sm:max-w-60"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            )}
          </div>
        </fieldset>

        {template && (
          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <div className="min-w-0 flex-1">
              <label className="label" htmlFor="send-test-phone">
                Send a test to your phone
              </label>
              <input
                id="send-test-phone"
                className="field"
                placeholder="+91 98765 43210"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              onClick={sendTest}
              disabled={testing || !testPhone.trim() || !connected}
            >
              {testing ? <Spinner className="size-3.5" /> : null}
              Send test
            </Button>
          </div>
        )}

        {blocker && <p className="text-[11.5px] text-ink-3">{blocker}</p>}
      </div>
    </Modal>
  );
}
