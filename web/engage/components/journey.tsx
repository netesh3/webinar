"use client";

import Link from "next/link";
import { CheckIcon, SendIcon } from "@/components/icons";
import { Card } from "@/components/ui";
import {
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  type CRMAudienceResponse,
  type CRMAutomaticStats,
  type CRMBroadcast,
  type CRMReplyAlert,
  type CRMSegment,
  type CRMWebinarResults,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import type { WatchBucket } from "../buckets";
import { AvatarStack, PersonAvatar, estimateCost, pct, rupees } from "./wa-kit";

/* Engage v2's webinar Messages tab pieces: the journey, the watch-time cards, the
 * next-step card, and the results. See docs/engage/V2.md, "Phase 2". */

function offsetText(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? "1 day" : `${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "1 hour" : `${min / 60} hours`;
  return min === 1 ? "1 minute" : `${min} minutes`;
}

type Step = {
  key: string;
  title: string;
  sub: string;
  stat: string;
  state: "done" | "now" | "next";
  tone?: string;
};

/** Registered → each reminder → Live → Follow up → Replay. */
export function journeySteps({
  automatic,
  results,
  broadcasts,
  buckets,
  ended,
}: {
  automatic: CRMAutomaticStats[];
  results: CRMWebinarResults;
  broadcasts: CRMBroadcast[];
  buckets: WatchBucket[];
  ended: boolean;
}): Step[] {
  const sentOf = (s?: CRMAutomaticStats) => (s ? s.sent : 0);
  const stat = (s?: CRMAutomaticStats) => {
    const n = sentOf(s);
    if (n > 0) return `${n} · ${pct(s!.read, n)} read`;
    if (s && s.queued > 0) return `${s.queued} queued`;
    return "Nothing sent";
  };
  const confirm = automatic.find((a) => a.kind === NotifyWhatsAppConfirmed);
  const reminders = automatic
    .filter((a) => a.kind === NotifyWhatsAppReminder)
    .sort((a, b) => (b.offsetMin ?? 0) - (a.offsetMin ?? 0));
  const replay = automatic.find((a) => a.kind === NotifyWhatsAppReplay);
  const followed = buckets.filter((b) =>
    broadcasts.some((x) => sameSegment(x.segment, b.segment)),
  ).length;

  const steps: Step[] = [
    {
      key: "reg",
      title: "Registered",
      sub: "Confirmation",
      stat: stat(confirm),
      state: sentOf(confirm) ? "done" : "next",
      tone: "text-ok",
    },
    ...reminders.map<Step>((r) => ({
      key: `r${r.offsetMin}`,
      title: `${offsetText(r.offsetMin ?? 0)} before`,
      sub: "Reminder",
      stat: stat(r),
      state: sentOf(r) > 0 ? "done" : "next",
      tone: "text-ok",
    })),
    {
      key: "live",
      title: "Live",
      sub: ended
        ? `${results.joined} joined · avg ${results.avgWatchMin} min`
        : "Not yet",
      stat: ended ? `${pct(results.joined, results.registered)} showed up` : "",
      state: ended ? "done" : "next",
      tone: "text-brand",
    },
    {
      key: "follow",
      title: "Follow up",
      sub: ended
        ? `${followed} of ${buckets.length} groups sent`
        : "After it ends",
      stat:
        ended && broadcasts.length
          ? `${broadcasts.reduce((n, b) => n + b.stats.replied, 0)} replies`
          : "",
      state: !ended ? "next" : followed === buckets.length ? "done" : "now",
      tone: "text-brand",
    },
    {
      key: "replay",
      title: "Replay",
      sub: replay && sentOf(replay) ? "Link sent" : "Publish to send",
      stat: replay && sentOf(replay) ? stat(replay) : "Not yet",
      state: replay && sentOf(replay) ? "done" : "next",
      tone: "text-ok",
    },
  ];
  return steps;
}

export function Journey({
  steps,
  audience,
}: {
  steps: Step[];
  audience: CRMAudienceResponse;
}) {
  const total =
    audience.recipients +
    audience.noOptIn +
    audience.optedOut +
    audience.noNumber;
  return (
    <Card className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-ink">
          This webinar on WhatsApp
        </h3>
        <p className="text-[11.5px] text-ink-3">
          {audience.recipients} of {total} registrants can get WhatsApp
          {audience.optedOut > 0 && ` · ${audience.optedOut} opted out`}
          {audience.noNumber > 0 && ` · ${audience.noNumber} no number`}
          {audience.noOptIn > 0 && ` · ${audience.noOptIn} didn't opt in`}
        </p>
      </div>
      <ol className="relative mt-4 grid gap-4 sm:flex sm:gap-0">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className="relative flex items-start gap-3 sm:flex-1 sm:flex-col sm:items-center sm:text-center"
          >
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={`absolute top-4 left-1/2 hidden h-0.5 w-full sm:block ${s.state === "done" ? "bg-ok/40" : "bg-line"}`}
              />
            )}
            <span
              className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-full text-white ${
                s.state === "done"
                  ? "bg-ok"
                  : s.state === "now"
                    ? "bg-brand ring-4 ring-brand-soft"
                    : "border-2 border-line-2 bg-surface text-ink-3"
              }`}
            >
              {s.state === "done" ? (
                <CheckIcon className="size-4" />
              ) : s.state === "now" ? (
                <SendIcon className="size-3.5" />
              ) : (
                <span className="size-2 rounded-full bg-line-2" />
              )}
            </span>
            <span className="grid gap-0.5 sm:mt-2">
              <span className="text-[12.5px] font-semibold text-ink">
                {s.title}
              </span>
              <span className="text-[11px] text-ink-3">{s.sub}</span>
              {s.stat && (
                <span
                  className={`text-[11.5px] font-medium ${s.state === "next" ? "text-ink-3" : s.tone}`}
                >
                  {s.stat}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function sameSegment(a: CRMSegment | undefined, b: CRMSegment): boolean {
  if (!a) return false;
  return (
    (a.attendance ?? "") === (b.attendance ?? "") &&
    (a.minWatchMin ?? 0) === (b.minWatchMin ?? 0) &&
    (a.maxWatchMin ?? 0) === (b.maxWatchMin ?? 0)
  );
}

/** One watch-time group: how many, who, and either what was sent or what to send. */
export function BucketCard({
  bucket,
  audience,
  sent,
  onSend,
}: {
  bucket: WatchBucket;
  audience: CRMAudienceResponse | undefined;
  sent: CRMBroadcast | undefined;
  onSend: () => void;
}) {
  const n = audience?.recipients;
  const people = (audience?.samples ?? []).map((s) => ({
    name: s.name,
    seed: s.contactId,
  }));
  return (
    <Card className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] text-ink-2">{bucket.label}</span>
        {sent ? (
          <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[10.5px] font-semibold text-ok">
            Sent
          </span>
        ) : n ? (
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10.5px] font-semibold text-brand">
            Suggested
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[26px] leading-none font-semibold text-ink tabular-nums">
          {n ?? "…"}
        </span>
        <AvatarStack people={people} />
      </div>
      {sent ? (
        <>
          <p className="rounded-lg bg-ok-soft px-3 py-2 text-[12px] leading-relaxed text-ok">
            {sent.name || sent.template} · <b>{sent.stats.read} read</b>
            {sent.stats.replied > 0 && (
              <>
                {" "}
                · <b>{sent.stats.replied} replied</b>
              </>
            )}
          </p>
          <div className="mt-auto flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-brand"
                style={{
                  width: pct(sent.stats.read, sent.stats.recipients).replace(
                    "–",
                    "0%",
                  ),
                }}
              />
            </div>
            <span className="text-[11px] text-ink-3 tabular-nums">
              {sent.stats.read}/{sent.stats.recipients}
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
            {bucket.suggestion}
          </p>
          <button
            type="button"
            onClick={onSend}
            disabled={!n}
            className="mt-auto inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-brand text-[12.5px] font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-line disabled:text-ink-3"
          >
            {n ? "Review & send" : "Nobody to message"}
          </button>
        </>
      )}
    </Card>
  );
}

export type NextStep = {
  title: string;
  hint: string;
  action: string;
  run: () => void;
  href?: string;
};

/* The one thing to do next, by rule: the people who didn't join and have heard nothing,
 * a reply about to lose its free window, then any group not yet followed up. */
export function nextStep({
  ended,
  buckets,
  audiences,
  broadcasts,
  waiting,
  now,
  onSend,
}: {
  ended: boolean;
  buckets: WatchBucket[];
  audiences: Record<string, CRMAudienceResponse>;
  broadcasts: CRMBroadcast[];
  waiting: CRMReplyAlert[];
  now: number;
  onSend: (b: WatchBucket) => void;
}): NextStep | null {
  const closing = waiting
    .map((w) => ({
      w,
      left: (new Date(w.at).getTime() + 24 * 3_600_000 - now) / 3_600_000,
    }))
    .filter((x) => x.left > 0 && x.left < 6)
    .sort((a, b) => a.left - b.left)[0];
  if (closing) {
    const h = Math.max(1, Math.floor(closing.left));
    return {
      title: `${closing.w.name}'s reply window closes in ${h} h`,
      hint: "After that you can only send an approved template. A quick answer now is free.",
      action: "Reply now",
      run: () => {},
      href: `/host?tab=messages&contact=${encodeURIComponent(closing.w.contactId)}`,
    };
  }
  if (!ended) return null;
  const open = buckets.filter(
    (b) =>
      (audiences[b.id]?.recipients ?? 0) > 0 &&
      !broadcasts.some((x) => sameSegment(x.segment, b.segment)),
  );
  const noShow = open.find((b) => b.id === "no_show");
  const first = noShow ?? open[0];
  if (!first) return null;
  const n = audiences[first.id].recipients;
  return first.id === "no_show"
    ? {
        title: `${n} ${n === 1 ? "person" : "people"} who didn't join haven't heard from you yet`,
        hint: "People who get a replay link within 24 hours are the ones who watch it.",
        action: `Send replay to ${n}`,
        run: () => onSend(first),
      }
    : {
        title: `${n} ${n === 1 ? "person" : "people"} ${first.label.toLowerCase()} and haven't heard from you`,
        hint: first.suggestion,
        action: `Message ${n}`,
        run: () => onSend(first),
      };
}

export function NextStepCard({ step }: { step: NextStep }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-line bg-brand-soft/60 px-4 py-3">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-[15px] text-white"
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

export function WaitingList({ waiting }: { waiting: CRMReplyAlert[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          Waiting for your reply
          <span className="grid size-5 place-items-center rounded-full bg-ok text-[10.5px] font-bold text-white">
            {waiting.length}
          </span>
        </h3>
        <Link
          href="/host?tab=messages"
          className="text-[12px] font-medium text-brand hover:underline"
        >
          Open Messages →
        </Link>
      </div>
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
    </Card>
  );
}

export function ResultsPanel({
  r,
  replies,
}: {
  r: CRMWebinarResults;
  replies: number;
}) {
  const cost = estimateCost({ marketing: r.marketing, utility: r.utility });
  const bars = [
    {
      label: "Showed up (WhatsApp reminded)",
      n: r.remindedJoined,
      of: r.reminded,
      color: "bg-brand",
    },
    {
      label: "Showed up (email only)",
      n: r.othersJoined,
      of: r.others,
      color: "bg-brand/35",
    },
  ];
  return (
    <Card className="px-4 py-3.5">
      <h3 className="text-[13px] font-semibold text-ink">
        What WhatsApp did for this webinar
      </h3>
      <div className="mt-3 grid gap-3">
        {bars.map((b) => (
          <div key={b.label} className="grid gap-1">
            <div className="flex justify-between text-[12px]">
              <span className="text-ink-2">{b.label}</span>
              <span className="font-semibold text-ink tabular-nums">
                {pct(b.n, b.of)}
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
      <dl className="mt-4 grid gap-2 border-t border-line pt-3 text-[12.5px]">
        {[
          ["Messages sent", String(r.sent)],
          ["Read", r.sent ? `${r.read} · ${pct(r.read, r.sent)}` : "–"],
          ["Replies", String(Math.max(r.replied, replies))],
          ["Est. Meta cost", `≈ ${rupees(cost)}`],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <dt className="text-ink-2">{k}</dt>
            <dd className="font-semibold text-ink tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
