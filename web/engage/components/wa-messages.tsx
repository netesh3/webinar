"use client";

import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Alert, Modal, Select, Spinner } from "@/components/controls";
import { useSession, useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  type CRMMergeField,
  type CRMReminder,
  type CRMTemplate,
  type NotificationKind,
} from "@/lib/api-types";
import { exampleFor, renderTemplate, templateKey } from "./crm-templates";
import { PhoneFrame } from "./wa-kit";

/* The three messages everyone who registers gets, as the WhatsApp page lists them and
 * edits them. Plain words throughout: a template is "wording", its category is what it
 * is for and what Meta charges, and the blanks fill themselves from the words around
 * them — the picker is still there for anyone who wants it. */

export const EVERYONE_MESSAGES: {
  kind: NotificationKind;
  title: string;
  when: string;
}[] = [
  {
    kind: NotifyWhatsAppConfirmed,
    title: "Confirmation",
    when: "when they register",
  },
  {
    kind: NotifyWhatsAppReminder,
    title: "Reminder",
    when: "before it starts · times set per webinar",
  },
  {
    kind: NotifyWhatsAppReplay,
    title: "Replay",
    when: "when you publish the recording",
  },
];

/** What a template is for, and roughly what Meta charges for one, in words. */
export function categoryWords(category: string): string {
  const c = category.toUpperCase();
  if (c === "MARKETING") return "Promotional · ≈₹0.78";
  if (c === "UTILITY") return "Update · ≈₹0.13";
  if (c === "AUTHENTICATION") return "Code";
  return c.toLowerCase();
}

/* Guesses what fills each {{n}} from the words just before it: "Hi {{1}}" is a first
 * name, "starts {{3}}" is how soon, "…ready: {{3}}" is the link. Falls back to the usual
 * order (first name, webinar, when). Right for every starter template and most others. */
export function guessParams(
  t: CRMTemplate,
  kind: NotificationKind,
  fields: CRMMergeField[],
): string[] {
  const has = (tok: string) =>
    fields.some((f) => f.token === tok && (!f.onlyKind || f.onlyKind === kind));
  const body = t.body ?? "";
  // The replay's link is what that message is for: offered in the fallback order too.
  const order = [
    "first_name",
    "topic",
    ...(kind === NotifyWhatsAppReplay ? ["replay"] : []),
    "when",
    "host",
  ].filter(has);
  const used = new Set<string>();
  const out: string[] = [];
  const re = /\{\{\s*[^}]+\s*\}\}/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(body)) && i < t.variables) {
    const before = body.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    let tok = "";
    if (/(hi|hello|hey|dear)\s*$/.test(before)) tok = "first_name";
    else if (/(starts|starting|begins)\s*$/.test(before) && has("starts_in"))
      tok = "starts_in";
    else if (/(on|at)\s*$/.test(before) && has("when")) tok = "when";
    else if (
      /(link|here|ready|watch|recording)[:\s]*$/.test(before) &&
      has("replay") &&
      kind === NotifyWhatsAppReplay
    )
      tok = "replay";
    else if (/(of|for|joining|attending|to)\s*$/.test(before) && has("topic"))
      tok = "topic";
    if (!tok || used.has(tok))
      tok = order.find((o) => !used.has(o)) ?? order[0] ?? "first_name";
    used.add(tok);
    out.push(tok);
    i++;
  }
  while (out.length < t.variables)
    out.push(order[out.length % Math.max(1, order.length)] ?? "first_name");
  return out;
}

/** The wording with each blank shown as what fills it: "Hi [first name], …". */
export function readable(
  body: string,
  params: string[],
  fields: CRMMergeField[],
): string {
  const label = (tok: string) =>
    (fields.find((f) => f.token === tok)?.label ?? tok).toLowerCase();
  return renderTemplate(
    body,
    params.map((p) => `[${label(p)}]`),
  );
}

export function MessageEditor({
  kind,
  title,
  current,
  templates,
  fields,
  onClose,
  onSaved,
  onWriteOwn,
}: {
  kind: NotificationKind;
  title: string;
  current: CRMReminder | undefined;
  templates: CRMTemplate[];
  fields: CRMMergeField[];
  onClose: () => void;
  onSaved: (all: CRMReminder[]) => void;
  onWriteOwn: () => void;
}) {
  const { notify } = useToast();
  const { account } = useSession();
  const usable = templates.filter((t) => t.sendable);
  const initial = usable.find(
    (t) => t.name === current?.template && t.language === current?.language,
  );
  const [chosen, setChosen] = useState(initial ? templateKey(initial) : "");
  const [params, setParams] = useState<string[]>(current?.params ?? []);
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState("");
  const [testing, setTesting] = useState(false);
  const [all, setAll] = useState<CRMReminder[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmReminders()
      .then((r) => !cancelled && setAll(r.reminders))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const template = usable.find((t) => templateKey(t) === chosen);
  const offered = fields.filter((f) => !f.onlyKind || f.onlyKind === kind);

  function pick(t: CRMTemplate) {
    setChosen(templateKey(t));
    setParams(guessParams(t, kind, fields));
    setError(null);
  }

  async function save(off = false) {
    if (!all) return;
    setSaving(true);
    try {
      const next = all.map((r) =>
        r.kind !== kind
          ? r
          : off || !template
            ? { ...r, template: "", language: "", params: [] }
            : {
                ...r,
                template: template.name,
                language: template.language,
                params,
              },
      );
      const res = await engageApi.setCrmReminders({ reminders: next });
      notify(off ? `${title} switched off.` : `${title} saved.`, "ok");
      onSaved(res.reminders);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that.");
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
        params: params.map((p) => ({ field: p })),
        phone: testPhone,
      });
      notify("Sent to your phone.", "ok");
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not send the test.",
        "error",
      );
    } finally {
      setTesting(false);
    }
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
      size="xl"
      title={`Edit the ${title.toLowerCase()}`}
      description="WhatsApp only sends wording Meta has approved. Pick one of yours, or write your own."
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {current?.template && (
            <button
              type="button"
              onClick={() => void save(true)}
              className="mr-auto text-[12.5px] text-ink-3 hover:text-live"
            >
              Don&apos;t send this on WhatsApp
            </button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || !template || !all}
          >
            {saving && <Spinner className="size-3.5" />}
            Save
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="grid content-start gap-3">
          {error && <Alert tone="error">{error}</Alert>}
          {usable.length === 0 ? (
            <Alert tone="warn">
              No approved wording yet.{" "}
              <button
                type="button"
                onClick={onWriteOwn}
                className="font-medium underline"
              >
                Write your own
              </button>{" "}
              — Meta usually approves it in minutes.
            </Alert>
          ) : (
            <div className="grid gap-2" role="radiogroup" aria-label="Wording">
              {usable.map((t) => {
                const on = templateKey(t) === chosen;
                const p = on ? params : guessParams(t, kind, fields);
                return (
                  <button
                    key={templateKey(t)}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pick(t)}
                    className={`rounded-xl border px-3.5 py-2.5 text-left transition ${
                      on
                        ? "border-brand ring-1 ring-brand"
                        : "border-line hover:border-line-2"
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                      {t.buttons?.length
                        ? `${friendly(t.name)} · with buttons`
                        : friendly(t.name)}
                      <span className="rounded bg-surface-2 px-1.5 py-px text-[10.5px] font-semibold text-ink-2">
                        {categoryWords(t.category)}
                      </span>
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-2">
                      {readable(t.body ?? "", p, fields)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {template && template.variables > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setCustom((v) => !v)}
                className="text-[12px] font-medium text-brand hover:underline"
              >
                {custom ? "Hide" : "Choose what fills each blank"}
              </button>
              {custom && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {params.map((p, i) => (
                    <Select
                      key={i}
                      label={`Blank ${i + 1}`}
                      value={p}
                      onChange={(v) =>
                        setParams((prev) =>
                          prev.map((q, j) => (j === i ? v : q)),
                        )
                      }
                    >
                      {offered.map((f) => (
                        <option key={f.token} value={f.token}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-[12px] text-ink-3">
            The words in [brackets] are filled in for each person.{" "}
            <button
              type="button"
              onClick={onWriteOwn}
              className="font-medium text-brand hover:underline"
            >
              Write your own wording
            </button>
          </p>
        </div>

        <aside className="grid content-start gap-3">
          <span className="text-[12px] font-medium text-ink-2">
            On their phone
          </span>
          <PhoneFrame
            title={account?.whatsapp?.verifiedName || account?.name || "You"}
            subtitle="Business account"
          >
            {template ? (
              <div className="max-w-[92%] rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#111] shadow-sm">
                {preview}
                {(template.buttons ?? []).map((b) => (
                  <span
                    key={b.text}
                    className="mt-1 block border-t border-black/5 pt-1 text-center font-medium text-[#027eb5]"
                  >
                    {b.type === "URL" ? "↗" : "↩"} {b.text}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[12px] text-ink-3">Pick the wording.</span>
            )}
          </PhoneFrame>
          {template && (
            <div className="flex gap-2">
              <input
                className="field h-9 text-[12.5px]"
                placeholder="Your number, to test"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void sendTest()}
                disabled={testing || !testPhone.trim()}
              >
                Test
              </Button>
            </div>
          )}
        </aside>
      </div>
    </Modal>
  );
}

function friendly(name: string): string {
  const s = name
    .replace(/^wl_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\bv\d+\b/gi, "")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
