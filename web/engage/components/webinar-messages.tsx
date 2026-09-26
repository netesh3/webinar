"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { Disclosure, Spinner } from "@/components/controls";
import { SendIcon } from "@/components/icons";
import { useToast } from "@/components/providers";
import { Badge, Button, Card, Empty } from "@/components/ui";
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
import { formatRelative } from "@/lib/format";
import { watchBuckets } from "../buckets";
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

  const refresh = useCallback(() => setTick((t) => t + 1), []);

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
          setError(e instanceof ApiError ? e.message : "Could not load this webinar's messages.");
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
        setTemplatesError(e instanceof ApiError ? e.message : "Could not load templates.");
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
          <Link href="/account" className="font-medium text-brand hover:underline">
            Account settings
          </Link>
        }
      />
    );
  }

  const a = data.audience;
  const buckets = watchBuckets(durationMin);

  return (
    <div className="grid gap-5">
      <Card className="px-4 py-3 text-[13px]">
        <span className="font-medium text-ink">
          {a.recipients} of {a.recipients + a.noOptIn + a.optedOut + a.noNumber} registrants
        </span>{" "}
        <span className="text-ink-2">
          can get WhatsApp messages
          {a.noOptIn + a.optedOut + a.noNumber > 0 &&
            ` · ${a.noOptIn} didn't opt in, ${a.optedOut} opted out, ${a.noNumber} no number`}
        </span>
      </Card>

      {ended && (
        <section className="grid gap-2">
          <h3 className="text-[13px] font-semibold text-ink">Follow up</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { id: "all", label: "Everyone registered", segment: {} },
              ...buckets,
            ].map((b) => (
              <Card key={b.id} className="flex items-center justify-between gap-2 px-4 py-3">
                <span className="text-[13px] font-medium text-ink">{b.label}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setTarget({ kind: "segment", webinarId: slug, segment: b.segment, label: b.label })
                  }
                >
                  <SendIcon className="size-3.5" />
                  Message
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}

      {data.waiting.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-[13px] font-semibold text-ink">
            Waiting for your reply <Badge tone="brand">{data.waiting.length}</Badge>
          </h3>
          <Card className="divide-y divide-line p-0">
            {data.waiting.map((w) => (
              <Link
                key={w.contactId}
                href={`/host?tab=messages&contact=${encodeURIComponent(w.contactId)}`}
                className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-surface-2"
              >
                <span className="font-medium text-ink">{w.name}</span>
                <span className="min-w-0 flex-1 truncate text-ink-3">Open the conversation</span>
                <span className="shrink-0 text-[11px] text-ink-3">
                  {formatRelative(w.at, new Date())}
                </span>
              </Link>
            ))}
          </Card>
        </section>
      )}

      <section className="grid gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Automatic messages</h3>
        <Card className="divide-y divide-line p-0">
          {data.automatic.map((s, i) => (
            <AutomaticRow
              key={`${s.kind}-${s.offsetMin ?? i}`}
              stats={s}
              template={data.templates.find((t) => t.kind === s.kind)?.template ?? ""}
            />
          ))}
        </Card>
        <p className="text-[11.5px] text-ink-3">
          Reminder times and the WhatsApp switch for this webinar are in its Settings.
        </p>
        <Disclosure summary="Change which template each message uses">
          <p className="mb-3 text-[12px] text-ink-3">
            These apply to all your webinars — the facts in each message (topic, time) come
            from the webinar.
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
        <h3 className="text-[13px] font-semibold text-ink">Follow-ups sent</h3>
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

function AutomaticRow({ stats: s, template }: { stats: CRMAutomaticStats; template: string }) {
  const sent = s.sent;
  const due = s.dueAt ? new Date(s.dueAt) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{automaticLabel(s)}</div>
        <div className="text-[11.5px] text-ink-3">
          {template ? `Template: ${template}` : "Off — no template chosen"}
          {due && due > new Date() && ` · sends ${formatRelative(s.dueAt!, new Date())}`}
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
          {b.template} · {b.status} · {formatRelative(b.scheduledAt || b.createdAt, new Date())}
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
