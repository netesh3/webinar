"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import type { AdminDayCount, AdminStats, AdminWebinarGlance } from "@/lib/api-types";
import { formatCount, formatDay, formatTimeRange, tzLabel } from "@/lib/format";
import { Alert } from "./controls";
import { Badge, ButtonLink, Card, Stat } from "./ui";

/* The first thing an operator sees.
 *
 * The accounts and webinars screens below this are for doing something to one
 * row. This is for noticing, before that, that a session is on air, that
 * hosting has been handed out more widely than anyone remembers, or that the
 * last fortnight was quiet. Every figure comes from GET /api/admin/stats —
 * adding the two management lists up in the browser would be wrong, because
 * the account list is capped and the webinar list is the full record.
 *
 * Drill-downs hand off to those screens rather than growing a third copy of
 * the filters. A stat that has nowhere to go (registrants, attendees) is not
 * a button: a control that opens nothing is a control that looks broken.
 */

export type WebinarStatusFilter = "" | "draft" | "scheduled" | "live" | "ended";

export function AdminDashboard({
  onAccounts,
  onWebinars,
}: {
  onAccounts: () => void;
  onWebinars: (status: WebinarStatusFilter) => void;
}) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Not async, and the state writes are inside .then().
   *
   * react-hooks/set-state-in-effect rejects an async function called from an
   * effect body — it cannot see that everything after the first await is a
   * later tick. Same shape as the account list this page already had. */
  const load = useCallback(() => {
    api
      .adminStats()
      .then((next) => {
        setStats(next);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load the dashboard.");
      });
  }, []);

  useEffect(load, [load]);

  if (stats === null) {
    return (
      <div className="grid gap-6">
        {error && <Alert tone="error">{error}</Alert>}
        {!error && <DashboardSkeleton />}
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {error && <Alert tone="error">{error}</Alert>}

      {/* Above the figures on purpose. A row of numbers can say "1 live" in
          the same voice as "6 accounts"; the banner cannot be skimmed past
          when a room is actually open. When nothing is live it is one quiet
          line, so the empty case does not push the rest of the page down. */}
      <LiveNow
        total={stats.live}
        rows={stats.liveNow}
        onSeeAll={() => onWebinars("live")}
      />

      <div>
        <h2 className="mb-2 text-[12px] font-semibold tracking-[0.02em] text-ink-2 uppercase">
          Accounts
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatLink onClick={onAccounts}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="Accounts"
              value={formatCount(stats.accounts)}
              note={
                stats.newAccounts7d === 0
                  ? "No new accounts in 7 days"
                  : `${formatCount(stats.newAccounts7d)} joined in the last 7 days`
              }
            />
          </StatLink>
          <StatLink onClick={onAccounts}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="Can host"
              value={formatCount(stats.hosts)}
              note="Allowed to create webinars"
              tone="brand"
            />
          </StatLink>
          <StatLink onClick={onAccounts}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="Admins"
              value={formatCount(stats.admins)}
              note="Set with ADMIN_EMAILS"
            />
          </StatLink>
          <StatLink onClick={onAccounts}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="CDN broadcast"
              value={formatCount(stats.cdnBroadcast)}
              note="May stream the audience over HLS"
              tone={stats.cdnBroadcast > 0 ? "ok" : "neutral"}
            />
          </StatLink>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-[12px] font-semibold tracking-[0.02em] text-ink-2 uppercase">
          Webinars
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatLink onClick={() => onWebinars("")}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="Webinars"
              value={formatCount(stats.webinars)}
              note={
                stats.drafts === 0
                  ? "No drafts"
                  : `${formatCount(stats.drafts)} draft${stats.drafts === 1 ? "" : "s"}`
              }
            />
          </StatLink>
          <StatLink onClick={() => onWebinars("live")}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="Live now"
              value={formatCount(stats.live)}
              note={stats.live === 0 ? "None on air" : "On air right now"}
              tone={stats.live > 0 ? "live" : "neutral"}
            />
          </StatLink>
          <StatLink onClick={() => onWebinars("scheduled")}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="Upcoming"
              value={formatCount(stats.scheduled)}
              note="Still scheduled"
              tone="brand"
            />
          </StatLink>
          <StatLink onClick={() => onWebinars("ended")}>
            <Stat
              className="h-full transition-colors hover:border-brand-line"
              label="Completed"
              value={formatCount(stats.ended)}
              note="Already ended"
              tone="ok"
            />
          </StatLink>
          <Stat
            label="Registrants"
            value={formatCount(stats.registrants)}
            note="Declined not counted"
          />
          <Stat
            label="Attendees"
            value={formatCount(stats.attendees)}
            note="Audience who joined a room"
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <StartTrend daily={stats.daily} />
        <FormatBreakdown stats={stats} />
      </div>

      {/* md is 768px, the same line useCompact treats as a phone (max-width
          767px). Below it the two lists stack; beside each other they are a
          glance, not the filterable table on the Webinars tab. */}
      <div className="grid gap-4 md:grid-cols-2">
        <GlanceList
          title="Coming up"
          rows={stats.upcoming}
          empty="Nothing is scheduled."
          onSeeAll={() => onWebinars("scheduled")}
        />
        <GlanceList
          title="Recently ended"
          rows={stats.recent}
          empty="No completed webinars yet."
          onSeeAll={() => onWebinars("ended")}
        />
      </div>
    </div>
  );
}

function StatLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-full cursor-pointer rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1"
    >
      {children}
    </button>
  );
}

function LiveNow({
  total,
  rows,
  onSeeAll,
}: {
  total: number;
  rows: AdminWebinarGlance[];
  onSeeAll: () => void;
}) {
  if (total === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-3">
        <span className="size-2 shrink-0 rounded-full bg-line-2" aria-hidden />
        <p className="text-[13px] text-ink-2">Nothing is live right now.</p>
      </div>
    );
  }

  const more = total - rows.length;

  return (
    <section
      aria-label="Live now"
      className="rounded-xl border border-live/30 bg-live-soft px-3 py-3 sm:px-4"
    >
      <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-live" />
          </span>
          <h2 className="text-[13px] font-semibold text-live">Live now</h2>
          <span className="text-[12.5px] text-live">
            {formatCount(total)} {total === 1 ? "session" : "sessions"}
          </span>
        </div>
        <button
          type="button"
          onClick={onSeeAll}
          className="rounded text-[12.5px] font-medium text-live outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          See all
        </button>
      </div>
      <div className="grid gap-2">
        {rows.map((w) => (
          <div
            key={w.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-live/20 bg-surface px-3 py-2.5"
          >
            <GlanceBody webinar={w} />
            <ButtonLink href={`/host/${w.id}`} size="sm">
              Open
            </ButtonLink>
          </div>
        ))}
      </div>
      {more > 0 && (
        <button
          type="button"
          onClick={onSeeAll}
          className="mt-2 px-1 text-[12.5px] font-medium text-live outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {formatCount(more)} more live
        </button>
      )}
    </section>
  );
}

function GlanceList({
  title,
  rows,
  empty,
  onSeeAll,
}: {
  title: string;
  rows: AdminWebinarGlance[];
  empty: string;
  onSeeAll: () => void;
}) {
  return (
    <div>
      {/* Same type as SectionTitle. That component's own margin can't sit in
          a row next to the link, so the heading is repeated here. */}
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-[0.01em] text-ink">
          {title}
        </h2>
        <button
          type="button"
          onClick={onSeeAll}
          className="rounded text-[12.5px] font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          See all
        </button>
      </div>
      <Card className="p-3">
        {rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-[13px] text-ink-2">{empty}</p>
        ) : (
          <div className="grid gap-2">
            {rows.map((w) => (
              <div
                key={w.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5"
              >
                <GlanceBody webinar={w} />
                <ButtonLink href={`/host/${w.id}`} variant="secondary" size="sm">
                  View
                </ButtonLink>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function GlanceBody({ webinar: w }: { webinar: AdminWebinarGlance }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium">{w.topic}</span>
        <Badge tone={statusTone(w.status)} dot={w.status === "live"}>
          {w.status}
        </Badge>
      </div>
      <div className="truncate text-[12px] text-ink-3">
        {formatDay(w.startsAt, w.timeZone)} ·{" "}
        {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
        {tzLabel(w.startsAt, w.timeZone)} · hosted by {w.hostName || "—"}
        {w.registrantCount > 0 &&
          ` · ${formatCount(w.registrantCount)} registrant${w.registrantCount === 1 ? "" : "s"}`}
      </div>
    </div>
  );
}

function statusTone(status: string): "neutral" | "brand" | "ok" | "live" {
  switch (status) {
    case "live":
      return "live";
    case "scheduled":
      return "brand";
    case "ended":
      return "ok";
    default:
      return "neutral";
  }
}

/* Last 28 UTC days, one bar per day the API returned — including the zeros.
 *
 * A YYYY-MM-DD parsed with Date.parse is UTC midnight, which is the previous
 * evening in any zone west of Greenwich, so a tick formatted in local time
 * would label the bar with the wrong day. The bucket's own calendar day is
 * what the axis has to say. */
function formatUtcDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function StartTrend({ daily }: { daily: AdminDayCount[] }) {
  const total = daily.reduce((n, d) => n + d.count, 0);
  const last7 = daily.slice(-7).reduce((n, d) => n + d.count, 0);
  let busiest: AdminDayCount | null = null;
  for (const d of daily) {
    if (!busiest || d.count > busiest.count) busiest = d;
  }

  let summary = "No webinars are set to start in the last 28 days.";
  if (total > 0 && busiest && busiest.count > 0) {
    summary = `${formatCount(total)} ${total === 1 ? "webinar is" : "webinars are"} set to start in this window, ${formatCount(last7)} in the last 7 days. Busiest day ${formatUtcDay(busiest.day)}, with ${formatCount(busiest.count)}.`;
  }

  return (
    <Card className="p-4 lg:col-span-3">
      <h2 className="text-[13px] font-semibold tracking-[0.01em] text-ink">
        Starts per day
      </h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{summary}</p>
      <p className="mt-0.5 text-[11.5px] text-ink-3">
        Last 28 days, UTC. Counted on the day the webinar is set to start.
      </p>
      {total > 0 && (
        <div className="mt-3 h-44 w-full min-w-0" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "var(--color-ink-3)" }}
                axisLine={{ stroke: "var(--color-line)" }}
                tickLine={false}
                interval={6}
                tickFormatter={(value) => formatUtcDay(String(value))}
              />
              <YAxis
                allowDecimals={false}
                width={36}
                tick={{ fontSize: 11, fill: "var(--color-ink-3)" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: "var(--color-surface-2)" }}
                contentStyle={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-line)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "var(--color-ink)",
                  boxShadow: "none",
                }}
                labelFormatter={(value) => formatUtcDay(String(value))}
                formatter={(value) => [formatCount(Number(value ?? 0)), "Webinars"]}
              />
              <Bar
                dataKey="count"
                name="Webinars"
                fill="var(--color-brand)"
                radius={[3, 3, 0, 0]}
                maxBarSize={18}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/* Format, not status. Live / upcoming / ended are already the stat tiles;
 * this is the other axis — a simulive and a series are both "webinars" up
 * there and are not the same thing to operate. The bar is aria-hidden
 * because the rows under it already say the numbers. */
const KIND_ROWS = [
  { key: "kindLive" as const, label: "Live webinar", fill: "var(--color-brand)" },
  { key: "kindSimulive" as const, label: "Simulive", fill: "var(--color-ok)" },
  { key: "kindRecurring" as const, label: "Series", fill: "var(--color-warn)" },
];

function FormatBreakdown({ stats }: { stats: AdminStats }) {
  const data = [
    {
      row: "formats",
      kindLive: stats.kindLive,
      kindSimulive: stats.kindSimulive,
      kindRecurring: stats.kindRecurring,
    },
  ];
  return (
    <Card className="p-4 lg:col-span-2">
      <h2 className="text-[13px] font-semibold tracking-[0.01em] text-ink">
        Format
      </h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        How webinars on this instance are set up to run.
      </p>
      {stats.webinars > 0 && (
        <div
          className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-2"
          aria-hidden
        >
          <ResponsiveContainer width="100%" height={10}>
            <BarChart
              layout="vertical"
              data={data}
              margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
            >
              <XAxis type="number" domain={[0, Math.max(stats.webinars, 1)]} hide />
              <YAxis type="category" dataKey="row" hide />
              {KIND_ROWS.map((kind) => (
                <Bar
                  key={kind.key}
                  dataKey={kind.key}
                  stackId="formats"
                  fill={kind.fill}
                  barSize={10}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <ul className="mt-3 grid gap-1.5">
        {KIND_ROWS.map((kind) => (
          <li key={kind.key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <span
                className="size-1.5 rounded-full"
                style={{ background: kind.fill }}
                aria-hidden
              />
              {kind.label}
            </span>
            <span className="text-[13px] font-medium tabular-nums">
              {formatCount(stats[kind.key])}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-6" aria-hidden>
      <div className="h-12 animate-pulse rounded-xl bg-surface-2" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-xl bg-surface-2" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-xl bg-surface-2" />
        ))}
      </div>
      <div className="h-56 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}
