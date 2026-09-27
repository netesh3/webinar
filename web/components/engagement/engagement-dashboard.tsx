"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { EngagementAttendeeRow } from "@/lib/api-types";
import { Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Badge, Button, ButtonLink, Card } from "@/components/ui";
import { ArrowLeftIcon } from "@/components/icons";
import { useEngagementSummary } from "@/lib/engagement/hooks";
import type { EngagementSource } from "@/lib/engagement/source";
import { pct } from "@/lib/engagement/viz";
import { AttendeeDrawer } from "./attendee-drawer";
import { AttendeeHeatmap } from "./attendee-heatmap";
import { ActivityHeatmap, Bars, RetentionChart } from "./charts";
import { DetailTabs } from "./detail-tabs";
import { FollowUpPanel, TierLevels, WhatsAppComposer, type SegmentId } from "./follow-up";
import { Hero } from "./hero";
import { KpiGrid } from "./kpi-grid";
import { Icon, Section } from "./primitives";
import { DashboardSkeleton, EmptyState, ErrorState, errorMessage } from "./states";

/* One webinar's engagement, read top to bottom: how did it go, who came and stayed, when
 * people took part, who took part (heatmap → drawer), what they said, and what to do next.
 * Composition only — every number arrives through `source`. */

export function EngagementDashboard({
  source,
  sample = false,
  backHref,
  signInHref,
}: {
  source: EngagementSource;
  sample?: boolean;
  /** The webinar's own page; the breadcrumb and back link point here. */
  backHref?: string;
  signInHref?: string;
}) {
  const { notify } = useToast();
  const summary = useEngagementSummary(source);
  const [open, setOpen] = useState<EngagementAttendeeRow | null>(null);
  const [compose, setCompose] = useState<SegmentId | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const closeDrawer = useCallback(() => setOpen(null), []);

  const s = summary.data;
  const ended = s?.webinar.status === "ended";
  const ready = s?.state === "ready";

  async function recompute() {
    if (!source.recompute) return;
    setRecomputing(true);
    try {
      summary.replace(await source.recompute());
      notify("Engagement recomputed.", "ok");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setRecomputing(false);
    }
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        {backHref && (
          <Link href={backHref} className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand">
            <ArrowLeftIcon className="size-3.5" />
            Back to webinar
          </Link>
        )}
        <nav aria-label="Breadcrumb">
          <ol className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
            <li>
              <Link href="/host" className="hover:text-ink">
                Webinars
              </Link>
            </li>
            <li aria-hidden>/</li>
            <li className="min-w-0 max-w-[40ch] truncate">
              {backHref ? (
                <Link href={backHref} className="hover:text-ink">
                  {s?.webinar.title ?? "Webinar"}
                </Link>
              ) : (
                (s?.webinar.title ?? "Webinar")
              )}
            </li>
            <li aria-hidden>/</li>
            <li className="font-medium text-ink" aria-current="page">
              Engagement
            </li>
            {sample && (
              <li className="ml-1">
                <Badge tone="warn">Sample data</Badge>
              </li>
            )}
          </ol>
        </nav>
      </div>
      <div className="flex flex-wrap gap-2">
        {source.csvUrl && ready && (
          <ButtonLink href={source.csvUrl} size="sm" variant="secondary" prefetch={false}>
            <Icon name="download" />
            Export CSV
          </ButtonLink>
        )}
        {source.recompute && ended && (
          <Button size="sm" variant="secondary" onClick={() => void recompute()} disabled={recomputing}>
            {recomputing ? <Spinner className="size-3.5" /> : <Icon name="refresh" />}
            Recompute
          </Button>
        )}
        {ready && (
          <Button size="sm" onClick={() => setCompose("engaged")}>
            <Icon name="schedule_send" />
            Schedule follow-up
          </Button>
        )}
      </div>
    </div>
  );

  if (!s) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:gap-5">
        {header}
        {summary.error != null && !summary.loading ? (
          <ErrorState error={summary.error} onRetry={summary.refresh} signInHref={signInHref} />
        ) : (
          <DashboardSkeleton />
        )}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:gap-5">
        {header}
        <EmptyState state={s.state} backHref={backHref} />
      </div>
    );
  }

  const k = s.kpis;
  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5">
      {header}
      {summary.live && (
        <p className="flex items-center gap-2 text-[12.5px] text-live" role="status">
          <span className="size-2 animate-pulse rounded-full bg-live" aria-hidden />
          Live — updates every 30s
        </p>
      )}
      {summary.error != null && <ErrorState error={summary.error} onRetry={summary.refresh} compact />}

      <Hero summary={s} />
      <KpiGrid kpis={k} />

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Section id="eng-retention" title="Who stayed" hint="People in the room, minute by minute. Dots mark polls, quizzes, Q&A and your offer.">
          <RetentionChart series={s.retention} markers={s.markers} sessionMin={s.webinar.sessionMin} attended={k.attended} />
        </Section>
        <Section id="eng-joins" title="When people joined" hint="Minutes relative to the start.">
          <div className="mb-3 flex gap-2 text-center text-[12px]">
            {[
              { key: "early", label: "Early", n: s.joinSplit.early, tone: "text-ok" },
              { key: "on", label: "On time", n: s.joinSplit.onTime, tone: "text-brand" },
              { key: "late", label: "Late (5m+)", n: s.joinSplit.late, tone: "text-warn" },
            ].map((x) => (
              <div key={x.key} className="flex-1 rounded-lg bg-surface-2 py-2">
                <div className={`text-[17px] font-semibold tabular-nums ${x.tone}`}>{pct(x.n, k.attended)}%</div>
                <div className="text-ink-3">{x.label}</div>
              </div>
            ))}
          </div>
          <Bars
            height={150}
            data={s.joinHistogram.map((h) => ({
              key: String(h.fromMin),
              label: `${h.fromMin < 0 ? h.fromMin : `+${h.fromMin}`}${h.open ? "+" : ""}`,
              value: h.count,
              color: h.fromMin < 0 ? "#0b8a4b" : h.fromMin < 5 ? "#0b5cff" : "#e0a54a",
            }))}
          />
        </Section>
      </div>

      <Section id="eng-activity" title="When people took part" hint="Interactions per minute. Darker means busier.">
        <ActivityHeatmap activity={s.activity} markers={s.markers} sessionMin={s.webinar.sessionMin} />
      </Section>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
        <Section id="eng-levels" title="Engagement levels" hint="Every attendee lands in one group, based on their score.">
          <TierLevels tiers={s.tiers} />
        </Section>
        <Card className="p-4 sm:p-5">
          <FollowUpPanel tiers={s.tiers} onCompose={setCompose} />
        </Card>
      </div>

      <Section
        id="eng-attendees"
        title="Attendee heatmap"
        hint={`Each row is one person across the ${s.webinar.sessionMin}-minute session. Sort, filter, or open a row for their full timeline.`}
      >
        <AttendeeHeatmap
          source={source}
          axis={s.axis}
          tiers={s.tiers}
          sessionMin={s.webinar.sessionMin}
          refreshKey={summary.live ? undefined : s.computedAt}
          onOpen={setOpen}
        />
      </Section>

      <Section id="eng-details" title="Interaction details">
        <DetailTabs summary={s} />
      </Section>

      <AttendeeDrawer source={source} row={open} lobbyMin={Math.max(0, -s.axis.startMin)} onClose={closeDrawer} />
      {compose && <WhatsAppComposer initial={compose} tiers={s.tiers} webinarTitle={s.webinar.title} onClose={() => setCompose(null)} />}
    </div>
  );
}
