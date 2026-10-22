"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Spinner } from "./controls";
import { CloseIcon, SendIcon } from "./icons";
import { useToast } from "./providers";
import { Badge, Button } from "./ui";
import { ENGAGE_HOME, FollowupTemplateCard } from "@/engage";
import { ApiError, api } from "@/lib/api";
import type { FollowupPlanResponse, FollowupSendResult } from "@/lib/api-types";
import {
  alreadySent,
  chunk,
  firstNameOf,
  planFor,
  reasonText,
  resultText,
  reviewRows,
  rowItem,
  summarize,
  whatsappPreview,
  type ChannelPref,
  type FollowupChannel,
  type ReviewRow,
} from "@/lib/followup-send";
import { groupLabel } from "@/lib/leads";

/* The one review screen for sending the AI follow-ups: every message, one row per person,
 * editable in place, rows removable, and nothing sent until the host presses Send. A per-lead
 * "Send email" / "Send WhatsApp" opens it with one row; "Send to selected" with many.
 *
 * Each row starts on WhatsApp when it can reach them (opted in, and inside the 24-hour
 * window or with our template approved) and falls back to email otherwise, saying why.
 * The server checks every row again when it is sent. A long list goes in chunks of the
 * server's maxPerRequest, with the progress shown. */
export function FollowupSendDialog({
  slug,
  topic,
  keys,
  group,
  lang,
  pref,
  onClose,
}: {
  slug: string;
  topic: string;
  keys: string[];
  group: string;
  lang: string;
  pref: ChannelPref;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const [plan, setPlan] = useState<FollowupPlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [again, setAgain] = useState(false);
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Record<string, FollowupSendResult>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctl = { cancelled: false };
    api
      .followupPlan(slug, keys, group, lang)
      .then((p) => {
        if (ctl.cancelled) return;
        setPlan(p);
        const next = reviewRows(p.recipients, pref);
        setRows(next);
        if (next.length === 1) setOpen({ [next[0].recipient.key]: true });
      })
      .catch((e) => {
        if (!ctl.cancelled) setError(e instanceof ApiError ? e.message : "Couldn't prepare the follow-ups.");
      });
    return () => {
      ctl.cancelled = true;
    };
    // keys is a fresh array per render of the caller; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, keys.join(","), group, lang, pref, reload]);

  const sendable = useMemo(
    () => rows.filter((r) => r.channel && !results[r.recipient.key] && (again || !alreadySent(r))),
    [rows, results, again],
  );
  const counts = useMemo(() => {
    let wa = 0;
    let email = 0;
    let none = 0;
    for (const r of rows) {
      if (r.channel === "whatsapp") wa++;
      else if (r.channel === "email") email++;
      else none++;
    }
    return { wa, email, none };
  }, [rows]);
  const anySent = rows.some(alreadySent);
  const templateBlocked = rows.some((r) => r.recipient.whatsappPlan.reason === "template_not_approved");

  const update = (key: string, patch: Partial<ReviewRow>) =>
    setRows((rs) => rs.map((r) => (r.recipient.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => setRows((rs) => rs.filter((r) => r.recipient.key !== key));

  async function send() {
    if (!plan || sending) return;
    const items = sendable.map(rowItem).filter((x) => x !== null);
    if (items.length === 0) return;
    const got: FollowupSendResult[] = [];
    setSending({ done: 0, total: items.length });
    try {
      for (const part of chunk(items, plan.maxPerRequest || 20)) {
        const res = await api.followupSend(slug, part, again, lang);
        got.push(...res.results);
        setResults((prev) => {
          const next = { ...prev };
          for (const r of res.results) next[r.key] = r;
          return next;
        });
        setSending({ done: got.length, total: items.length });
      }
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Sending stopped part-way. What went is marked.", "error");
    } finally {
      setSending(null);
    }
    const s = summarize(got);
    if (got.length > 0) {
      notify(
        `${s.sent} sent${s.skipped ? `, ${s.skipped} skipped` : ""}${s.failed ? `, ${s.failed} failed` : ""}.`,
        s.failed ? "error" : "ok",
      );
    }
  }

  const finished = Object.keys(results).length > 0 && sendable.length === 0;
  const footer = (
    <>
      {anySent && !finished && (
        <label className="mr-auto flex items-center gap-2 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
          Send again to people who already had it
        </label>
      )}
      <Button type="button" variant="ghost" onClick={onClose} disabled={Boolean(sending)}>
        {finished ? "Done" : "Cancel"}
      </Button>
      {!finished && (
        <Button type="button" onClick={() => void send()} disabled={!plan || Boolean(sending) || sendable.length === 0}>
          {sending ? <Spinner /> : <SendIcon className="size-3.5" />}
          {sending
            ? `Sending ${sending.done} of ${sending.total}…`
            : sendable.length === 1
              ? "Send 1 message"
              : `Send ${sendable.length} messages`}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open
      onClose={sending ? () => undefined : onClose}
      dismissible={!sending}
      size="xl"
      title="Review and send follow-ups"
      description="Every message is below. Edit any of them, remove anybody, then press Send. Nothing goes until you do."
      footer={footer}
    >
      {error && <Alert tone="error">{error}</Alert>}
      {!plan && !error && (
        <p className="flex items-center gap-2 text-[13px] text-ink-2">
          <Spinner /> Preparing the messages…
        </p>
      )}
      {plan && (
        <div className="grid gap-3">
          <p className="text-[12.5px] text-ink-2">
            {rows.length === 1 ? "1 person" : `${rows.length} people`}: {counts.wa} on WhatsApp, {counts.email} by email
            {counts.none ? `, ${counts.none} can't be reached` : ""}.
          </p>
          {!plan.whatsappConnected && pref !== "email" && (
            <Alert tone="info" title="WhatsApp isn't connected">
              Follow-ups go by email for now.{" "}
              <Link href={`${ENGAGE_HOME}?view=setup`} className="font-medium text-brand hover:underline">
                Connect WhatsApp
              </Link>{" "}
              to send them from your own business number.
            </Alert>
          )}
          {plan.whatsappConnected && templateBlocked && (
            <div className="grid gap-1.5">
              <p className="text-[12.5px] text-ink-2">
                WhatsApp only allows a typed message within 24 hours of somebody&apos;s last message to you. For everyone
                else it needs our follow-up template approved by Meta; until then they get the email instead.
              </p>
              <FollowupTemplateCard
                compact
                onStatus={(st) => {
                  if (st.toUpperCase() === "APPROVED" && plan.templateStatus !== "APPROVED") setReload((n) => n + 1);
                }}
              />
            </div>
          )}
          {!plan.emailEnabled && <Alert tone="warn">Email isn&apos;t set up on this server, so only WhatsApp can be sent.</Alert>}
          <ul className="grid gap-2">
            {rows.map((row) => (
              <ReviewRowItem
                key={row.recipient.key}
                row={row}
                topic={topic}
                expanded={Boolean(open[row.recipient.key])}
                result={results[row.recipient.key]}
                again={again}
                disabled={Boolean(sending)}
                onToggle={() => setOpen((o) => ({ ...o, [row.recipient.key]: !o[row.recipient.key] }))}
                onChange={(patch) => update(row.recipient.key, patch)}
                onRemove={() => remove(row.recipient.key)}
              />
            ))}
          </ul>
          {rows.length === 0 && <p className="text-[13px] text-ink-2">Nobody left to send to.</p>}
        </div>
      )}
    </Modal>
  );
}

function ReviewRowItem({
  row,
  topic,
  expanded,
  result,
  again,
  disabled,
  onToggle,
  onChange,
  onRemove,
}: {
  row: ReviewRow;
  topic: string;
  expanded: boolean;
  result?: FollowupSendResult;
  again: boolean;
  disabled: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ReviewRow>) => void;
  onRemove: () => void;
}) {
  const r = row.recipient;
  const wa = r.whatsappPlan;
  const em = r.emailPlan;
  const sentBefore = alreadySent(row);
  const plan = row.channel ? planFor(r, row.channel) : null;
  const preview =
    row.channel === "whatsapp" ? row.whatsapp : row.channel === "email" ? `${row.subject} · ${row.body}` : "";
  const choose = (c: FollowupChannel) => onChange({ channel: c, fallback: false });
  const locked = disabled || Boolean(result);

  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-medium text-ink">{r.name || "Guest"}</span>
        <span className="text-[11.5px] text-ink-3">{groupLabel(r.group)}</span>
        <div className="inline-flex rounded-md border border-line p-0.5" role="group" aria-label={`Channel for ${r.name}`}>
          {(["whatsapp", "email"] as FollowupChannel[]).map((c) => {
            const p = c === "email" ? em : wa;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={row.channel === c}
                disabled={!p.available || locked}
                title={p.available ? undefined : reasonText(p.reason)}
                onClick={() => choose(c)}
                className={`rounded px-2 py-0.5 text-[12px] disabled:opacity-40 ${
                  row.channel === c ? "bg-brand-soft text-brand" : "text-ink-2 hover:text-ink"
                }`}
              >
                {c === "email" ? "Email" : "WhatsApp"}
              </button>
            );
          })}
        </div>
        {sentBefore && <Badge tone={again ? "warn" : "neutral"}>{again ? "Sending again" : "Already sent"}</Badge>}
        <span className="ml-auto flex items-center gap-1">
          {row.channel && !result && (
            <button
              type="button"
              className="h-7 rounded-md px-2 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink"
              onClick={onToggle}
              aria-expanded={expanded}
            >
              {expanded ? "Done editing" : "Edit"}
            </button>
          )}
          {!result && (
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
              onClick={onRemove}
              disabled={disabled}
              aria-label={`Remove ${r.name}`}
            >
              <CloseIcon className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-[12px] text-ink-3">
        {row.channel === "whatsapp"
          ? `${r.phone ?? ""} · ${wa.mode === "template" ? "as the follow-up template (outside the 24-hour window)" : "as a message (they wrote in the last 24 hours)"}`
          : row.channel === "email"
            ? `${r.email ?? ""}${row.fallback ? ` · email instead: ${reasonText(wa.reason).toLowerCase()}` : ""}`
            : `Can't be reached: ${reasonText(wa.reason)}; ${reasonText(em.reason).toLowerCase()}`}
      </p>
      {result && (
        <p className={`mt-1 text-[12.5px] font-medium ${result.status === "sent" ? "text-ok" : result.status === "failed" ? "text-live" : "text-ink-2"}`}>
          {resultText(result)}
        </p>
      )}
      {!result && row.channel && !expanded && <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-2">{preview}</p>}
      {!result && row.channel && expanded && (
        <div className="mt-2 grid gap-2">
          {row.channel === "email" ? (
            <>
              <input
                className="field"
                aria-label="Email subject"
                value={row.subject}
                maxLength={200}
                disabled={locked}
                onChange={(e) => onChange({ subject: e.target.value })}
              />
              <textarea
                className="field min-h-32 resize-y py-2"
                aria-label="Email"
                value={row.body}
                maxLength={5000}
                disabled={locked}
                onChange={(e) => onChange({ body: e.target.value })}
              />
              <p className="text-[11.5px] text-ink-3">Sent from your name, replies come to you. An unsubscribe line is added at the end.</p>
            </>
          ) : (
            <>
              <textarea
                className="field min-h-24 resize-y py-2"
                aria-label="WhatsApp message"
                value={row.whatsapp}
                maxLength={1024}
                disabled={locked}
                onChange={(e) => onChange({ whatsapp: e.target.value })}
              />
              {plan?.mode === "template" && (
                <div className="rounded-md bg-surface-2 px-3 py-2">
                  <p className="text-[11.5px] font-medium text-ink-3">What they&apos;ll read (the template keeps it on one line)</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-ink-2">
                    {whatsappPreview("template", firstNameOf(r.name), topic, row.whatsapp)}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
