"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CheckIcon, SendIcon } from "@/components/icons";
import { Card } from "@/components/ui";
import {
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  type CRMAudienceResponse,
  type CRMAutomaticStats,
  type CRMBroadcast,
  type CRMReminder,
  type CRMReplyAlert,
  type CRMWebinarResults,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import { PersonAvatar, estimateCost, pct, rupees } from "./wa-kit";

/* A webinar's Messages tab, v2.1: what WhatsApp sent for it and who answered. Deciding who
 * to follow up with lives on the Engagement tab (EngagementFollowUp); attendance lives
 * there too. See docs/engage/V2.md, "v2.1". */

export function offsetText(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? "1 day" : `${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "1 hour" : `${min / 60} hours`;
  return min === 1 ? "1 minute" : `${min} minutes`;
}

const replied = (bs: CRMBroadcast[]) =>
  bs.reduce((n, b) => n + b.stats.replied, 0);

/* ------------------------------------------------------------------ numbers */

/** Only what WhatsApp knows: reach, sent, read, replies, what Meta will bill. */
export function WhatsAppKpis({
  audience: a,
  results: r,
  broadcasts,
  waiting,
}: {
  audience: CRMAudienceResponse;
  results: CRMWebinarResults;
  broadcasts: CRMBroadcast[];
  waiting: number;
}) {
  const total = a.recipients + a.noOptIn + a.optedOut + a.noNumber;
  const followSent = broadcasts.reduce((n, b) => n + b.stats.sent, 0);
  const autoSent = Math.max(0, r.sent - followSent);
  const replies = Math.max(r.replied, replied(broadcasts));
  const why = [
    a.optedOut && `${a.optedOut} opted out`,
    a.noNumber && `${a.noNumber} no number`,
    a.noOptIn && `${a.noOptIn} no consent`,
  ].filter(Boolean);
  const cells: { label: string; value: string; of?: string; sub: string }[] = [
    {
      label: "Can get WhatsApp",
      value: String(a.recipients),
      of: `/ ${total}`,
      sub: why.join(" · ") || "Everyone registered",
    },
    {
      label: "Messages sent",
      value: String(r.sent),
      sub: `automatic ${autoSent} · follow-ups ${followSent}`,
    },
    {
      label: "Read",
      value: pct(r.read, r.sent),
      sub: r.sent ? `${r.read} of ${r.sent}` : "Nothing sent yet",
    },
    {
      label: "Replies",
      value: String(replies),
      sub: waiting ? `${waiting} waiting on you` : "None waiting",
    },
    {
      label: "Est. Meta cost",
      value: `≈ ${rupees(estimateCost({ marketing: r.marketing, utility: r.utility }))}`,
      sub: `${r.marketing} marketing · ${r.utility} utility`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((c) => (
        <Card key={c.label} className="px-4 py-3">
          <div className="text-[12px] text-ink-2">{c.label}</div>
          <div className="mt-1 text-[22px] leading-tight font-semibold text-ink tabular-nums">
            {c.value}
            {c.of && (
              <span className="ml-1 text-[12px] font-normal text-ink-3">
                {c.of}
              </span>
            )}
          </div>
          <div
            className="mt-0.5 truncate text-[11.5px] text-ink-3"
            title={c.sub}
          >
            {c.sub}
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ timeline */

type Row = {
  key: string;
  when: string;
  title: string;
  sub: string;
  state: "done" | "queued" | "followup" | "idle";
  stats: { label: string; tone?: string }[];
  action?: { label: string; run?: () => void; href?: string };
};

/** Every message this webinar sent or will send, in the order the attendee gets them. */
export function timelineRows({
  automatic,
  templates,
  broadcasts,
  ended,
  now,
  engagementHref,
  onCancel,
}: {
  automatic: CRMAutomaticStats[];
  templates: CRMReminder[];
  broadcasts: CRMBroadcast[];
  ended: boolean;
  now: number | null;
  engagementHref: string;
  onCancel: (b: CRMBroadcast) => void;
}): Row[] {
  const tpl = (kind: string) =>
    templates.find((t) => t.kind === kind)?.template ?? "";
  const auto = (s: CRMAutomaticStats, when: string, title: string): Row => {
    const t = tpl(s.kind);
    const due =
      s.dueAt && now !== null && new Date(s.dueAt).getTime() > now
        ? s.dueAt
        : "";
    const stats: Row["stats"] =
      s.sent > 0
        ? [
            { label: `${s.sent} sent` },
            {
              label: `${pct(s.read, s.sent)} read`,
              tone: "text-ok font-semibold",
            },
          ]
        : s.queued > 0
          ? [{ label: `${s.queued} queued` }]
          : [];
    if (s.failed > 0)
      stats.push({ label: `${s.failed} failed`, tone: "text-live" });
    return {
      key: `${s.kind}-${s.offsetMin ?? 0}`,
      when,
      title,
      sub: !t
        ? "Off — no template chosen"
        : due && now !== null
          ? `${t} · sends ${formatRelative(due, new Date(now))}`
          : t,
      state: s.sent > 0 ? "done" : "queued",
      stats,
    };
  };

  const rows: Row[] = [];
  const confirm = automatic.find((a) => a.kind === NotifyWhatsAppConfirmed);
  if (confirm) rows.push(auto(confirm, "On registering", "Confirmation"));
  automatic
    .filter((a) => a.kind === NotifyWhatsAppReminder)
    .sort((a, b) => (b.offsetMin ?? 0) - (a.offsetMin ?? 0))
    .forEach((r) =>
      rows.push(auto(r, `${offsetText(r.offsetMin ?? 0)} before`, "Reminder")),
    );

  const follow = [...broadcasts]
    .filter((b) => b.status !== "cancelled")
    .sort((a, b) =>
      (a.scheduledAt || a.createdAt).localeCompare(
        b.scheduledAt || b.createdAt,
      ),
    );
  for (const b of follow) {
    const at = b.scheduledAt || b.createdAt;
    const scheduled = b.status === "scheduled";
    rows.push({
      key: b.id,
      when: now === null ? "" : formatRelative(at, new Date(now)),
      title: `Follow-up · ${b.segmentLabel || b.name}`,
      sub: `${b.template}${scheduled ? " · scheduled" : ""}`,
      state: scheduled ? "queued" : "followup",
      stats: scheduled
        ? [{ label: `${b.stats.recipients} queued` }]
        : [
            { label: `${b.stats.sent} sent` },
            { label: `${b.stats.read} read`, tone: "text-ok font-semibold" },
            ...(b.stats.replied
              ? [
                  {
                    label: `${b.stats.replied} replied`,
                    tone: "text-brand font-semibold",
                  },
                ]
              : []),
            ...(b.stats.failed
              ? [{ label: `${b.stats.failed} failed`, tone: "text-live" }]
              : []),
          ],
      action: scheduled
        ? { label: "Cancel", run: () => onCancel(b) }
        : undefined,
    });
  }
  if (ended && follow.length === 0) {
    rows.push({
      key: "follow",
      when: "After it ended",
      title: "Follow-ups",
      sub: "Nothing sent yet — pick who, by how they took part",
      state: "idle",
      stats: [],
      action: { label: "Go to Follow up", href: engagementHref },
    });
  }

  const replay = automatic.find((a) => a.kind === NotifyWhatsAppReplay);
  if (replay && replay.sent > 0)
    rows.push(auto(replay, "On publishing", "Replay link"));
  else
    rows.push({
      key: "replay",
      when: "On publishing",
      title: "Replay link",
      sub: tpl(NotifyWhatsAppReplay)
        ? "Sends when you publish the recording"
        : "Off — no template chosen",
      state: "idle",
      stats: [],
    });
  return rows;
}

export function Timeline({
  rows,
  footer,
  title = "Everything sent for this webinar",
}: {
  rows: Row[];
  footer?: ReactNode;
  title?: string;
}) {
  return (
    <Card className="px-5 py-4">
      <h3 className="text-[13.5px] font-semibold text-ink">
        {title}
      </h3>
      <ol className="mt-2 divide-y divide-line">
        {rows.map((r) => (
          <li
            key={r.key}
            className="grid grid-cols-[96px_24px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[110px_24px_minmax(0,1fr)_auto]"
          >
            <span className="text-right text-[11.5px] text-ink-3">
              {r.when}
            </span>
            <span
              className={`grid size-6 place-items-center rounded-full text-white ${
                r.state === "done"
                  ? "bg-ok"
                  : r.state === "followup"
                    ? "bg-brand"
                    : "border border-line-2 bg-surface-2 text-ink-3"
              }`}
              aria-hidden
            >
              {r.state === "done" ? (
                <CheckIcon className="size-3.5" />
              ) : r.state === "followup" ? (
                <SendIcon className="size-3" />
              ) : (
                <span className="size-1.5 rounded-full bg-line-2" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-ink">
                {r.title}
              </span>
              <span className="block truncate text-[11.5px] text-ink-3">
                {r.sub}
              </span>
            </span>
            <span className="col-start-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2 tabular-nums sm:col-start-auto sm:justify-end">
              {r.stats.map((s) => (
                <span key={s.label} className={s.tone}>
                  {s.label}
                </span>
              ))}
              {r.action &&
                (r.action.href ? (
                  <Link
                    href={r.action.href}
                    className="font-medium text-brand hover:underline"
                  >
                    {r.action.label}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={r.action.run}
                    className="font-medium text-brand hover:underline"
                  >
                    {r.action.label}
                  </button>
                ))}
            </span>
          </li>
        ))}
      </ol>
      {footer}
    </Card>
  );
}

/* ------------------------------------------------------------------ nudge */

export type NextStep = {
  title: string;
  hint: string;
  action: string;
  run: () => void;
  href?: string;
};

/** The one WhatsApp-only nudge: a reply about to lose its free 24-hour window. */
export function replyClosing(
  waiting: CRMReplyAlert[],
  now: number,
): NextStep | null {
  const closing = waiting
    .map((w) => ({
      w,
      left: (new Date(w.at).getTime() + 24 * 3_600_000 - now) / 3_600_000,
    }))
    .filter((x) => x.left > 0 && x.left < 6)
    .sort((a, b) => a.left - b.left)[0];
  if (!closing) return null;
  const h = Math.max(1, Math.floor(closing.left));
  return {
    title: `${closing.w.name}'s reply window closes in ${h} h`,
    hint: closing.w.preview
      ? `“${closing.w.preview}” — answering now is free; after that only a template can be sent.`
      : "Answering now is free; after that only an approved template can be sent.",
    action: "Reply now",
    run: () => {},
    href: `/host?tab=messages&contact=${encodeURIComponent(closing.w.contactId)}`,
  };
}

export function NextStepCard({
  step,
  tone = "brand",
}: {
  step: NextStep;
  tone?: "brand" | "ok";
}) {
  const box =
    tone === "ok"
      ? "border-ok/25 bg-ok-soft/60"
      : "border-brand-line bg-brand-soft/60";
  const icon = tone === "ok" ? "bg-ok" : "bg-brand";
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${box}`}
    >
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-lg text-[15px] text-white ${icon}`}
        aria-hidden
      >
        ✦
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{step.title}</p>
        <p className="text-[12px] text-ink-2">{step.hint}</p>
      </div>
      {step.href ? (
        <Link
          href={step.href}
          className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-[12.5px] font-semibold text-white hover:bg-brand-hover"
        >
          {step.action}
        </Link>
      ) : (
        <button
          type="button"
          onClick={step.run}
          className="h-9 rounded-lg bg-brand px-4 text-[12.5px] font-semibold text-white hover:bg-brand-hover"
        >
          {step.action}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ side panels */

export function WaitingList({ waiting }: { waiting: CRMReplyAlert[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          Waiting for your reply
          {waiting.length > 0 && (
            <span className="grid size-5 place-items-center rounded-full bg-ok text-[10.5px] font-bold text-white">
              {waiting.length}
            </span>
          )}
        </h3>
        <Link
          href="/host?tab=messages"
          className="text-[12px] font-medium text-brand hover:underline"
        >
          Open Messages →
        </Link>
      </div>
      {waiting.length === 0 ? (
        <p className="px-4 py-5 text-center text-[12.5px] text-ink-3">
          No replies waiting. When people answer, they show up here and on the
          bell.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {waiting.slice(0, 5).map((w) => (
            <Link
              key={w.contactId}
              href={`/host?tab=messages&contact=${encodeURIComponent(w.contactId)}`}
              className="flex gap-3 px-4 py-3 hover:bg-surface-2"
            >
              <PersonAvatar name={w.name} seed={w.contactId} size={32} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">
                    {w.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-3">
                    {formatRelative(w.at, new Date())}
                  </span>
                </span>
                <span className="block truncate text-[12.5px] text-ink-2">
                  {w.preview ? `“${w.preview}”` : "Open the conversation"}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Show-up by whether a WhatsApp reminder reached them — the comparison a coach pays for. */
export function RemindersHelp({ r }: { r: CRMWebinarResults }) {
  const bars = [
    {
      label: "Got a WhatsApp reminder",
      n: r.remindedJoined,
      of: r.reminded,
      color: "bg-brand",
    },
    {
      label: "Email only",
      n: r.othersJoined,
      of: r.others,
      color: "bg-brand/35",
    },
  ];
  return (
    <Card className="px-4 py-3.5">
      <h3 className="text-[13px] font-semibold text-ink">
        Did the reminders help?
      </h3>
      <div className="mt-3 grid gap-3">
        {bars.map((b) => (
          <div key={b.label} className="grid gap-1">
            <div className="flex justify-between text-[12px]">
              <span className="text-ink-2">{b.label}</span>
              <span className="font-semibold text-ink tabular-nums">
                {pct(b.n, b.of)}
                <span className="ml-1 text-[11px] font-normal text-ink-3">
                  {b.n}/{b.of}
                </span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full ${b.color}`}
                style={{ width: b.of ? `${(b.n / b.of) * 100}%` : 0 }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-ink-3">
        Show-up rate by who got a reminder. Small groups swing a lot — this
        settles after a few webinars.
      </p>
    </Card>
  );
}
