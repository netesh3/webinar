"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { Disclosure, Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Card, Empty } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  type CRMAutomaticStats,
  type CRMBroadcast,
  type CRMTemplate,
  type CRMWebinarMessagesResponse,
} from "@/lib/api-types";
import { AudienceSegment, type CRMAudienceResponse } from "@/lib/api-types";
import { useNow } from "@/lib/clock";
import { formatRelative } from "@/lib/format";
import { watchBuckets, type WatchBucket } from "../buckets";
import {
  BucketCard,
  Journey,
  NextStepCard,
  ResultsPanel,
  WaitingList,
  journeySteps,
  nextStep,
  sameSegment,
} from "./journey";
import { RemindersSettings } from "./crm-screen";
import { SendDialog, type SendTarget } from "./send-dialog";

/* A webinar's Messages tab: every WhatsApp message this one webinar sends, in one place.
 *
 * Before it: the automatic ones — confirmation and each reminder time — with how many
 * went out and were read. After it: follow-ups by how long people watched, the
 * follow-ups already sent, and whoever has written back and is waiting.
 */
export function WebinarMessagesTab({
  slug,
  ended,
  durationMin,
}: {
  slug: string;
  ended: boolean;
  durationMin: number;
}) {
  const { notify } = useToast();
  const [data, setData] = useState<CRMWebinarMessagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [target, setTarget] = useState<SendTarget | null>(null);
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const [audiences, setAudiences] = useState<
    Record<string, CRMAudienceResponse>
  >({});
  const now = useNow();
  const buckets = watchBuckets(durationMin);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Each group's count and first few faces, for the cards. Only once it has ended.
  useEffect(() => {
    if (!ended) return;
    let cancelled = false;
    Promise.all(
      watchBuckets(durationMin).map((b) =>
        engageApi
          .crmAudienceFor({
            name: "",
            template: "",
            language: "",
            audience: AudienceSegment,
            webinarId: slug,
            segment: b.segment,
            params: [{ field: "first_name" }],
          })
          .then((a) => [b.id, a] as const)
          .catch(() => null),
      ),
    ).then((all) => {
      if (cancelled) return;
      const next: Record<string, CRMAudienceResponse> = {};
      for (const x of all) if (x) next[x[0]] = x[1];
      setAudiences(next);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, ended, durationMin, tick]);

  function openBucket(b: WatchBucket) {
    setTarget({
      kind: "segment",
      webinarId: slug,
      segment: b.segment,
      label: b.label,
      hints: b.hints,
    });
  }

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmWebinarMessages(slug)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(
            e instanceof ApiError
              ? e.message
              : "Could not load this webinar's messages.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [slug, tick]);

  useEffect(() => {
    loadTemplates();
    // Once per mount: templates change about once a week.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadTemplates(refresh = false) {
    if (refresh) setSyncing(true);
    engageApi
      .crmTemplates(refresh)
      .then((res) => {
        setTemplates(res.templates);
        setTemplatesError(null);
      })
      .catch((e: unknown) => {
        setTemplates([]);
        setTemplatesError(
          e instanceof ApiError ? e.message : "Could not load templates.",
        );
        if (refresh) notify("Could not reach WhatsApp.", "error");
      })
      .finally(() => setSyncing(false));
  }

  if (error && !data) return <Empty title={error} />;
  if (!data)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  if (!data.whatsappConnected) {
    return (
      <Empty
        title="WhatsApp isn't connected"
        hint="Connect your WhatsApp Business number to send confirmations, reminders and follow-ups for this webinar."
        action={
          <Link
            href="/account"
            className="font-medium text-brand hover:underline"
          >
            Account settings
          </Link>
        }
      />
    );
  }

  const steps = journeySteps({
    automatic: data.automatic,
    results: data.results,
    broadcasts: data.broadcasts,
    buckets,
    ended,
  });
  const next =
    now === null
      ? null
      : nextStep({
          ended,
          buckets,
          audiences,
          broadcasts: data.broadcasts,
          waiting: data.waiting,
          now,
          onSend: openBucket,
        });
  const replies = data.broadcasts.reduce((n, b) => n + b.stats.replied, 0);

  return (
    <div className="grid gap-5">
      {next && <NextStepCard step={next} />}

      <Journey steps={steps} audience={data.audience} />

      {ended && (
        <section className="grid gap-2">
          <h3 className="text-[13px] font-semibold text-ink">
            Follow up, by how long they watched
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {buckets.map((b) => (
              <BucketCard
                key={b.id}
                bucket={b}
                audience={audiences[b.id]}
                sent={data.broadcasts.find((x) =>
                  sameSegment(x.segment, b.segment),
                )}
                onSend={() => openBucket(b)}
              />
            ))}
          </div>
          <button
            type="button"
            className="justify-self-start text-[12px] font-medium text-brand hover:underline"
            onClick={() =>
              setTarget({
                kind: "segment",
                webinarId: slug,
                segment: {},
                label: "Everyone registered",
              })
            }
          >
            Or message everyone registered
          </button>
        </section>
      )}

      {(data.waiting.length > 0 || ended) && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {data.waiting.length > 0 ? (
            <WaitingList waiting={data.waiting} />
          ) : (
            <Card className="px-4 py-6 text-center text-[12.5px] text-ink-3">
              No replies waiting. When people answer, they show up here and on
              the bell.
            </Card>
          )}
          {ended && <ResultsPanel r={data.results} replies={replies} />}
        </div>
      )}

      <Disclosure summary="Every message, in detail">
        <div className="grid gap-5 pt-2">
          <section className="grid gap-2">
            <h3 className="text-[13px] font-semibold text-ink">
              Automatic messages
            </h3>
            <Card className="divide-y divide-line p-0">
              {data.automatic.map((s, i) => (
                <AutomaticRow
                  key={`${s.kind}-${s.offsetMin ?? i}`}
                  stats={s}
                  template={
                    data.templates.find((t) => t.kind === s.kind)?.template ??
                    ""
                  }
                />
              ))}
            </Card>
            <p className="text-[11.5px] text-ink-3">
              Reminder times and the WhatsApp switch for this webinar are in its
              Settings.
            </p>
            <Disclosure summary="Change which template each message uses">
              <p className="mb-3 text-[12px] text-ink-3">
                These apply to all your webinars — the facts in each message
                (topic, time) come from the webinar.
              </p>
              <RemindersSettings
                templates={templates}
                templatesError={templatesError}
                syncing={syncing}
                onRefreshTemplates={() => loadTemplates(true)}
                onSaved={refresh}
              />
            </Disclosure>
          </section>

          <section className="grid gap-2">
            <h3 className="text-[13px] font-semibold text-ink">
              Follow-ups sent
            </h3>
            {data.broadcasts.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">
                {ended
                  ? "None yet. Pick who to message above."
                  : "After the webinar ends you can message people by how long they watched."}
              </p>
            ) : (
              <Card className="divide-y divide-line p-0">
                {data.broadcasts.map((b) => (
                  <BroadcastRow key={b.id} broadcast={b} />
                ))}
              </Card>
            )}
          </section>
        </div>
      </Disclosure>

      <SendDialog
        open={target !== null}
        target={target}
        onClose={() => setTarget(null)}
        onSent={refresh}
      />
    </div>
  );
}

function automaticLabel(s: CRMAutomaticStats): string {
  switch (s.kind) {
    case NotifyWhatsAppConfirmed:
      return "Confirmation, when they register";
    case NotifyWhatsAppReminder:
      return `Reminder, ${offsetText(s.offsetMin ?? 0)} before`;
    case NotifyWhatsAppReplay:
      return "Replay link, when you publish the recording";
    default:
      return s.kind;
  }
}

export function offsetText(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? "1 day" : `${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "1 hour" : `${min / 60} hours`;
  return min === 1 ? "1 minute" : `${min} minutes`;
}

function AutomaticRow({
  stats: s,
  template,
}: {
  stats: CRMAutomaticStats;
  template: string;
}) {
  const sent = s.sent;
  const due = s.dueAt ? new Date(s.dueAt) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{automaticLabel(s)}</div>
        <div className="text-[11.5px] text-ink-3">
          {template ? `Template: ${template}` : "Off — no template chosen"}
          {due &&
            due > new Date() &&
            ` · sends ${formatRelative(s.dueAt!, new Date())}`}
        </div>
      </div>
      <div className="flex gap-3 text-[12px] tabular-nums text-ink-2">
        <span>{sent} sent</span>
        <span>{s.delivered} delivered</span>
        <span className="text-ok">{s.read} read</span>
        {s.queued > 0 && <span>{s.queued} queued</span>}
        {s.failed > 0 && <span className="text-live">{s.failed} failed</span>}
      </div>
    </div>
  );
}

function BroadcastRow({ broadcast: b }: { broadcast: CRMBroadcast }) {
  const s = b.stats;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{b.segmentLabel || b.name}</div>
        <div className="text-[11.5px] text-ink-3">
          {b.template} · {b.status} ·{" "}
          {formatRelative(b.scheduledAt || b.createdAt, new Date())}
        </div>
      </div>
      <div className="flex gap-3 text-[12px] tabular-nums text-ink-2">
        <span>{s.recipients} to</span>
        <span>{s.sent} sent</span>
        <span className="text-ok">{s.read} read</span>
        <span className="text-brand">{s.replied} replied</span>
        {s.failed > 0 && <span className="text-live">{s.failed} failed</span>}
      </div>
    </div>
  );
}
