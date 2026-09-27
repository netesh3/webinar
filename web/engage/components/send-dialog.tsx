"use client";

import { useEffect, useRef, useState } from "react";
import { engageApi } from "../api";
import {
  Alert,
  Modal,
  Select,
  Spinner,
  openPickerOnClick,
} from "@/components/controls";
import { WhatsAppIcon } from "@/components/icons";
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
import { exampleFor, templateKey } from "./crm-templates";
import {
  PhonePreview,
  RecipientStrip,
  TemplateCards,
  bestTemplate,
} from "./send-parts";
import { WA_SEND, estimateCost, rupees } from "./wa-kit";

/* The one send dialog: "Message these N" from the Attendees tab, the People tab, and a
 * webinar's Messages tab all open this.
 *
 * Who is fixed by the caller — a watch-time bucket of one webinar, or people ticked by
 * hand — and shown at the top as four numbers from the server. The template is picked
 * from cards, the best one for this group first; the preview is the message as each
 * real recipient will read it (the server fills their values), on a phone, with an
 * estimate of what Meta will charge.
 */

export type SendTarget =
  | {
      kind: "segment";
      webinarId: string;
      segment: CRMSegment;
      label: string;
      hints?: string[];
    }
  | {
      kind: "contacts";
      contactIds: string[];
      webinarId?: string;
      label: string;
      hints?: string[];
    };

const LITERAL = "\u0000text";

/** Enough to get names back for the avatars before a template is picked. */
const NAME_ONLY: CRMParam[] = [{ field: "first_name" }];

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

function audienceBody(
  target: SendTarget,
  params: CRMParam[] = [],
): CRMBroadcastRequest {
  const base = { name: "", template: "", language: "", params };
  return target.kind === "segment"
    ? {
        ...base,
        audience: AudienceSegment,
        webinarId: target.webinarId,
        segment: target.segment,
      }
    : {
        ...base,
        audience: AudienceContacts,
        contactIds: target.contactIds,
        webinarId: target.webinarId,
      };
}

/** 9 AM tomorrow, local, as the datetime-local value the picker uses. */
function tomorrowNine(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
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
  const [best, setBest] = useState("");
  const [params, setParams] = useState<CRMParam[]>([]);
  const [timing, setTiming] = useState<"now" | "tomorrow" | "later">("now");
  const [at, setAt] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = Boolean(account?.whatsapp?.connected);
  const from =
    account?.whatsapp?.verifiedName || account?.name || "Your business";

  const hasWebinar = Boolean(target.webinarId);
  const offered = fields.filter(
    (f) => hasWebinar || !["topic", "when", "watched"].includes(f.token),
  );

  function paramsFor(
    t: CRMTemplate | undefined,
    available: CRMMergeField[],
  ): CRMParam[] {
    if (!t) return [];
    const order = ["first_name", "topic", "when", "host"].filter((tok) =>
      available.some(
        (f) =>
          f.token === tok && (hasWebinar || !["topic", "when"].includes(tok)),
      ),
    );
    return Array.from({ length: t.variables }, (_, i) =>
      order[i] ? { field: order[i] } : { text: "" },
    );
  }

  // Templates and fields, once; the best template for this group is picked for them.
  useEffect(() => {
    let cancelled = false;
    Promise.all([engageApi.crmTemplates(), engageApi.crmBroadcasts()])
      .then(([t, b]) => {
        if (cancelled) return;
        const sendable = t.templates.filter((x) => x.sendable);
        // Fields that only mean something on an automatic message are not offered.
        const f = b.fields.filter(
          (x) =>
            !x.onlyKind ||
            (x.onlyKind !== NotifyWhatsAppReplay &&
              x.onlyKind !== NotifyWhatsAppReminder),
        );
        const top = bestTemplate(sendable, target.hints ?? []);
        // The best one first, then the order Meta returned them in.
        setTemplates(
          [...sendable].sort(
            (a, z) =>
              Number(templateKey(z) === top) - Number(templateKey(a) === top),
          ),
        );
        setFields(f);
        setBest(top);
        if (top) {
          setChosen(top);
          setParams(
            paramsFor(
              sendable.find((x) => templateKey(x) === top),
              f,
            ),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
    // Once per dialog: the target does not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Who gets it, and each of the first few with their values filled in. Re-read as
   * the values change, a moment after the last keystroke. */
  const seq = useRef(0);
  const ready = params.every((p) => p.field || (p.text ?? "").trim());
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    const mine = ++seq.current;
    const handle = setTimeout(() => {
      engageApi
        .crmAudienceFor(
          audienceBody(target, params.length && ready ? params : NAME_ONLY),
        )
        .then((a) => {
          if (mine === seq.current) setAudience(a);
        })
        .catch((e: unknown) => {
          if (mine === seq.current)
            setAudienceError(
              e instanceof ApiError
                ? e.message
                : "Could not count these people.",
            );
        });
    }, 250);
    return () => clearTimeout(handle);
    // paramsKey stands for params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, paramsKey, ready]);

  const template = (templates ?? []).find((t) => templateKey(t) === chosen);

  function pick(key: string) {
    setChosen(key);
    setParams(
      paramsFor(
        (templates ?? []).find((x) => templateKey(x) === key),
        fields,
      ),
    );
  }

  const when =
    timing === "tomorrow" ? tomorrowNine() : timing === "later" ? at : "";
  const scheduledAt = when
    ? zonedToInstant(when.slice(0, 10), when.slice(11, 16), localTimeZone())
    : null;
  const reach = audience?.recipients ?? 0;

  const blocker = !connected
    ? "Connect WhatsApp in Account settings to send."
    : !template
      ? "Pick a template."
      : !ready
        ? "Fill every blank — WhatsApp rejects a message with a gap in it."
        : timing !== "now" && !scheduledAt
          ? "Pick when to send it."
          : audience && reach === 0
            ? "None of these people can be messaged on WhatsApp."
            : null;

  const samples = params.length && ready ? (audience?.samples ?? []) : [];
  const fallback = params.map((p) =>
    p.field ? exampleFor(fields, p.field) : (p.text ?? ""),
  );
  const category = template?.category.toUpperCase() ?? "";
  const cost = estimateCost({
    marketing: category === "MARKETING" ? reach : 0,
    utility:
      category === "UTILITY" || category === "AUTHENTICATION" ? reach : 0,
  });

  async function send() {
    if (blocker || !template) return;
    setSaving(true);
    try {
      const b = await engageApi.createCrmBroadcast({
        ...audienceBody(target, params),
        name: target.label,
        template: template.name,
        language: template.language,
        scheduledAt: scheduledAt ? scheduledAt.toISOString() : undefined,
      });
      const n = b.stats.recipients;
      notify(
        `${scheduledAt ? "Scheduled for" : "Sending to"} ${n} ${n === 1 ? "person" : "people"}.`,
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
      notify(
        e instanceof ApiError ? e.message : "Could not send the test.",
        "error",
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Message · ${target.label}`}
      description={`Sent on WhatsApp from ${account?.whatsapp?.displayPhone || "your number"}, billed to your Meta account.`}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <button
            type="button"
            className="mr-auto text-[12.5px] font-medium text-brand hover:underline disabled:opacity-50"
            onClick={() => setTestOpen((v) => !v)}
            disabled={!template}
          >
            Send a test to my phone
          </button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={send}
            disabled={saving || blocker !== null}
            className="inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: WA_SEND }}
          >
            {saving ? (
              <Spinner className="size-3.5" />
            ) : (
              <WhatsAppIcon className="size-4" />
            )}
            {timing === "now"
              ? `Send to ${reach} on WhatsApp`
              : `Schedule for ${reach}`}
          </button>
        </div>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17.5rem]">
        <div className="grid content-start gap-4">
          {error && <Alert tone="error">{error}</Alert>}

          <section className="grid gap-1.5">
            <span className="label">Who gets it</span>
            <RecipientStrip audience={audience} error={audienceError} />
          </section>

          <section className="grid gap-1.5">
            <span className="label">Message</span>
            {templates === null ? (
              <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
                <Spinner className="size-4" /> Loading templates…
              </div>
            ) : templates.length === 0 ? (
              <Alert tone="warn">
                No approved templates yet. WhatsApp only lets you message people
                who haven&apos;t written to you with a template Meta has
                approved — create one in WhatsApp Manager.
              </Alert>
            ) : (
              <TemplateCards
                templates={templates}
                chosen={chosen}
                best={best}
                onPick={pick}
              />
            )}
          </section>

          {template && params.length > 0 && (
            <section className="grid gap-2">
              <span className="label">Filled in with</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {params.map((p, i) => (
                  <div key={i} className="grid gap-1.5">
                    <Select
                      label={`Blank ${i + 1}`}
                      value={p.field || LITERAL}
                      onChange={(next) =>
                        setParams((prev) =>
                          prev.map((q, j) =>
                            j === i
                              ? next === LITERAL
                                ? { text: "" }
                                : { field: next }
                              : q,
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
                        aria-label={`What blank ${i + 1} says`}
                        value={p.text ?? ""}
                        onChange={(e) =>
                          setParams((prev) =>
                            prev.map((q, j) =>
                              j === i ? { text: e.target.value } : q,
                            ),
                          )
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <fieldset className="grid gap-1.5">
            <legend className="label">When</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  { id: "now", title: "Now", hint: "Goes out in a minute" },
                  {
                    id: "tomorrow",
                    title: "Tomorrow 9 AM",
                    hint: "Most people read in the morning",
                  },
                  { id: "later", title: "Pick a time", hint: "Your time zone" },
                ] as const
              ).map((o) => (
                <label
                  key={o.id}
                  className={`cursor-pointer rounded-xl border px-3 py-2.5 transition ${
                    timing === o.id
                      ? "border-brand ring-1 ring-brand"
                      : "border-line hover:border-line-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="send-timing"
                    className="sr-only"
                    checked={timing === o.id}
                    onChange={() => setTiming(o.id)}
                  />
                  <span className="block text-[13px] font-medium text-ink">
                    {o.title}
                  </span>
                  <span className="block text-[11px] text-ink-3">{o.hint}</span>
                </label>
              ))}
            </div>
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
          </fieldset>

          {testOpen && template && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface-2 p-3">
              <div className="min-w-0 flex-1">
                <label className="label" htmlFor="send-test-phone">
                  Your phone, with country code
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

        <aside className="grid content-start gap-3">
          {template ? (
            <>
              <PhonePreview
                template={template}
                samples={samples}
                fallback={fallback}
                from={from}
              />
              {reach > 0 && (
                <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[12px] leading-relaxed text-ink-2">
                  <div className="text-[13.5px] font-semibold text-ink">
                    ≈ {rupees(cost)} on your Meta account
                  </div>
                  {reach} {category.toLowerCase() || "template"} message
                  {reach === 1 ? "" : "s"}, estimated at Meta&apos;s India rate.
                  Their replies, and yours within 24 hours, are free.
                </div>
              )}
            </>
          ) : (
            <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-line px-4 text-center text-[12.5px] text-ink-3">
              Pick a template to see it the way they will.
            </div>
          )}
        </aside>
      </div>
    </Modal>
  );
}
