"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { ENGAGE_HOME } from "../slots";
import { MaterialIcon, WhatsAppIcon } from "@/components/icons";
import { useAppConfig, useSession } from "@/components/providers";
import type { CRMWebinarMetricsResponse } from "@/lib/api-types";
import { FailureDialog, MetricTiles } from "./metric-tiles";

/* WhatsApp numbers for one ended webinar, under the Follow up group cards.
 *
 * The same five tiles as the WhatsApp page, compact, plus how the sends split.
 * Absent when WhatsApp is not connected, and when nothing has been sent: an
 * empty card would sit under the groups saying zero. */

function peopleHint(n: number): string {
  if (n === 1) return "to 1 person";
  return `to ${n} people`;
}

export function WebinarWhatsAppMetrics({
  slug,
  topic,
}: {
  slug: string;
  topic: string;
}) {
  const { whatsappConnect } = useAppConfig();
  const { account } = useSession();
  const connected = Boolean(whatsappConnect && account?.whatsapp?.connected);
  const [metrics, setMetrics] = useState<CRMWebinarMetricsResponse | null>(null);
  const [why, setWhy] = useState(false);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    engageApi
      .crmWebinarMetrics(slug)
      .then((res) => {
        if (!cancelled) setMetrics(res);
      })
      .catch(() => {
        if (!cancelled) setMetrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, connected]);

  if (!connected || !metrics || metrics.sent === 0) return null;

  const { byKind } = metrics;
  const kinds: { label: string; n: number; quiet?: string }[] = [
    { label: "Confirmation", n: byKind.confirmation },
    { label: "Reminders", n: byKind.reminders },
    { label: "Follow-ups", n: byKind.followUps },
    {
      label: "Replay",
      n: byKind.replay,
      quiet: byKind.replay === 0 ? "goes out when you publish" : undefined,
    },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <span className="grid size-[26px] shrink-0 place-items-center rounded-md bg-ok-soft text-ok">
            <WhatsAppIcon className="size-4" />
          </span>
          <b className="font-semibold text-ink">WhatsApp for this webinar</b>
          <span className="truncate text-[12px] text-ink-3">
            · everything sent from your number for {topic}
          </span>
        </div>
        <Link
          href={ENGAGE_HOME}
          className="inline-flex shrink-0 items-center gap-0.5 text-[12.5px] font-medium text-brand hover:underline"
        >
          All WhatsApp
          <MaterialIcon name="arrow_forward" className="!text-[15px]" />
        </Link>
      </div>
      <MetricTiles
        compact
        metrics={metrics}
        sentHint={peopleHint(metrics.people)}
        onSeeWhy={() => setWhy(true)}
      />
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-t border-line bg-surface-2 px-4 py-2.5 text-[12.5px] text-ink-2">
        <span className="text-[11.5px] font-semibold text-ink-3">By message</span>
        {kinds.map((k) => (
          <span key={k.label} className={k.quiet ? "text-ink-3" : undefined}>
            {k.label}
            <b
              className={`ml-1 tabular-nums ${k.quiet ? "font-medium text-ink-3" : "font-semibold text-ink"}`}
            >
              {k.n}
            </b>
            {k.quiet && <span> · {k.quiet}</span>}
          </span>
        ))}
        <span className="ml-auto">
          = <b className="font-semibold text-ink">{metrics.sent} sent</b>
        </span>
      </div>
      {why && (
        <FailureDialog failures={metrics.failures} onClose={() => setWhy(false)} />
      )}
    </section>
  );
}
