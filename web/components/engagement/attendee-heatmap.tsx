"use client";

import { useState } from "react";
import type { EngagementAttendeeRow, EngagementAxis, EngagementTierCounts } from "@/lib/api-types";
import { Button } from "@/components/ui";
import { Spinner } from "@/components/controls";
import { useEngagementAttendees } from "@/lib/engagement/hooks";
import { DEFAULT_FILTERS, nextSort, type AttendeeFilters, type SortKey } from "@/lib/engagement/query";
import { TIER_META, TIER_ORDER, asTier, type Tier } from "@/lib/engagement/score";
import type { EngagementSource } from "@/lib/engagement/source";
import { HEAT_LEGEND, cellColor, columnLabels, columnStartMin, joinLabel, pct } from "@/lib/engagement/viz";
import { clockAt, leaveState } from "@/lib/engagement/sections";
import { formatTime } from "@/lib/format";
import { Initials, ScorePill, TierChip } from "./primitives";
import { ErrorState } from "./states";

/* Rows are attendees, columns are the summary's axis buckets. Colour is how much of the
 * bucket they were present for, darkened by how much they did — a solid dark row stayed and
 * took part; a pale row with gaps is the person to follow up. Sorting, filtering and paging
 * happen on the server; this only asks. */

function SortHeader({
  label,
  column,
  filters,
  onSort,
  className = "",
}: {
  label: string;
  column: SortKey;
  filters: AttendeeFilters;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = filters.sort === column;
  return (
    <th
      scope="col"
      className={`px-2 py-2 font-medium ${className}`}
      aria-sort={active ? (filters.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
        onClick={() => onSort(column)}
      >
        {label}
        <span aria-hidden className={active ? "text-brand" : "text-ink-3/60"}>
          {active && filters.dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

function HeatCells({ row, axis }: { row: EngagementAttendeeRow; axis: EngagementAxis }) {
  return (
    <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${axis.columns}, minmax(0, 1fr))` }}>
      {Array.from({ length: axis.columns }, (_, i) => {
        const p = row.presence[i] ?? 0;
        const n = row.intensity[i] ?? 0;
        const from = columnStartMin(axis, i);
        return (
          <div
            key={i}
            className={`h-6 ${i === 0 ? "rounded-l" : ""} ${i === axis.columns - 1 ? "rounded-r" : ""} ${
              axis.lobbyColumns > 0 && i === axis.lobbyColumns ? "ml-1" : ""
            }`}
            style={{ background: cellColor(p, n) }}
            title={`${from}–${from + axis.bucketMin}m · ${p}% present · ${n} actions`}
          />
        );
      })}
    </div>
  );
}

export interface HeatmapClock {
  startedAt?: string;
  timeZone: string;
  live: boolean;
}

function InOut({ row, sessionMin, clock }: { row: EngagementAttendeeRow; sessionMin: number; clock?: HeatmapClock }) {
  const at = (m: number) => {
    const iso = clock ? clockAt(clock.startedAt, m) : null;
    return iso && clock ? formatTime(iso, clock.timeZone) : null;
  };
  const leave = leaveState(row.lastLeaveMin, sessionMin, clock?.live ?? false);
  const inAt = at(row.firstJoinMin);
  return (
    <>
      <div className="text-ink tabular-nums">
        {inAt ?? joinLabel(row.firstJoinMin)}
        <span aria-hidden className="px-1 text-ink-3">→</span>
        <span className="sr-only"> to </span>
        {leave.kind === "left" ? (at(leave.minute) ?? `${leave.minute}m`) : leave.kind === "still_in" ? <span className="text-live">still in</span> : <span className="text-ink-2">end</span>}
      </div>
      <div className="text-[11px] text-ink-3 tabular-nums">
        {inAt ? `${joinLabel(row.firstJoinMin)} · ` : ""}
        {row.visits} {row.visits === 1 ? "visit" : "visits"}
      </div>
    </>
  );
}

export function AttendeeHeatmap({
  source,
  axis: summaryAxis,
  tiers,
  sessionMin,
  refreshKey,
  onOpen,
  clock,
}: {
  source: EngagementSource;
  axis: EngagementAxis;
  tiers: EngagementTierCounts;
  sessionMin: number;
  refreshKey?: string;
  onOpen: (row: EngagementAttendeeRow) => void;
  /** Turns minute offsets into the clock times the old attendance table showed. */
  clock?: HeatmapClock;
}) {
  const [filters, setFilters] = useState<AttendeeFilters>(DEFAULT_FILTERS);
  const list = useEngagementAttendees(source, filters, refreshKey);
  const axis = list.axis ?? summaryAxis;
  const labels = columnLabels(axis);
  const attended = TIER_ORDER.reduce((s, t) => s + tiers[t], 0);

  const toggleTier = (t: Tier) =>
    setFilters((f) => ({ ...f, tiers: f.tiers.includes(t) ? f.tiers.filter((x) => x !== t) : [...f.tiers, t] }));
  const onSort = (k: SortKey) => setFilters((f) => ({ ...f, ...nextSort(f, k) }));
  const chip = (pressed: boolean) =>
    `h-8 rounded-full border px-3 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 ${
      pressed ? "border-ink bg-ink text-white" : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2"
    }`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <span className="sr-only">Search attendees by name or email</span>
          <input
            type="search"
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Search by name or email"
            className="h-9 w-full rounded-lg border border-line-2 bg-surface px-3 text-[13px] outline-none placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by engagement level">
          <button type="button" aria-pressed={filters.tiers.length === 0} onClick={() => setFilters((f) => ({ ...f, tiers: [] }))} className={chip(filters.tiers.length === 0)}>
            All <span className="tabular-nums opacity-70">{attended}</span>
          </button>
          {TIER_ORDER.map((t) => (
            <button key={t} type="button" aria-pressed={filters.tiers.includes(t)} onClick={() => toggleTier(t)} className={chip(filters.tiers.includes(t))}>
              {TIER_META[t].label} <span className="tabular-nums opacity-70">{tiers[t]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 max-h-[560px] overflow-auto rounded-lg border border-line" aria-busy={list.loading || list.stale}>
        <table className={`w-full min-w-[940px] border-collapse text-[12.5px] transition-opacity ${list.stale ? "opacity-60" : ""}`}>
          <caption className="sr-only">Attendees, when they were in the room, and their presence across the session</caption>
          <thead className="sticky top-0 z-10 bg-surface-2 text-left text-[11.5px] text-ink-2 shadow-[0_1px_0_#e5e9ec]">
            <tr>
              <SortHeader label="Attendee" column="name" filters={filters} onSort={onSort} className="pl-3" />
              <SortHeader label="Score" column="score" filters={filters} onSort={onSort} />
              <SortHeader label="Watched" column="watch" filters={filters} onSort={onSort} />
              <SortHeader label="In → Out" column="join" filters={filters} onSort={onSort} />
              <th scope="col" className="px-2 py-2 font-medium">
                <span className="sr-only">Presence by {axis.bucketMin}-minute bucket</span>
                <div className="grid gap-[2px] tabular-nums text-ink-3" aria-hidden style={{ gridTemplateColumns: `repeat(${axis.columns}, minmax(0, 1fr))` }}>
                  {labels.map((l, i) => (
                    <span key={i} className={`whitespace-nowrap ${axis.lobbyColumns > 0 && i === axis.lobbyColumns ? "ml-1" : ""}`}>
                      {l}
                    </span>
                  ))}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.loading && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-ink-3">
                  <Spinner className="mx-auto size-5" />
                </td>
              </tr>
            )}
            {!list.loading && !list.error && list.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-ink-3">
                  Nobody matches that search.
                </td>
              </tr>
            )}
            {list.rows.map((r) => (
              <tr
                key={r.identity}
                tabIndex={0}
                onClick={() => onOpen(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(r);
                  }
                }}
                aria-label={`${r.name}, score ${r.score}, ${TIER_META[asTier(r.tier)].label}. Open details.`}
                className="cursor-pointer border-t border-line outline-none hover:bg-brand-soft/40 focus-visible:bg-brand-soft/60"
              >
                <td className="py-1.5 pr-2 pl-3">
                  <div className="flex items-center gap-2.5">
                    <Initials name={r.name} seed={r.identity} size={28} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink" title={r.email || undefined}>{r.name}</div>
                      <TierChip tier={r.tier} />
                    </div>
                  </div>
                </td>
                <td className="px-2">
                  <ScorePill score={r.score} tier={r.tier} />
                </td>
                <td className="px-2 whitespace-nowrap tabular-nums">
                  {r.watchMin}m <span className="text-ink-3">· {pct(r.watchMin, sessionMin)}%</span>
                </td>
                <td className="px-2 whitespace-nowrap">
                  <InOut row={r} sessionMin={sessionMin} clock={clock} />
                </td>
                <td className="w-[48%] px-2">
                  <HeatCells row={r} axis={axis} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.error != null && (
        <div className="mt-3">
          <ErrorState error={list.error} compact />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-3">
        <div className="flex items-center gap-3">
          <span aria-live="polite">
            Showing {list.rows.length} of {list.total} · Each column is {axis.bucketMin} minutes
          </span>
          {list.hasMore && (
            <Button size="sm" variant="secondary" onClick={list.loadMore} disabled={list.loadingMore}>
              {list.loadingMore && <Spinner className="size-3.5" />}
              Load more
            </Button>
          )}
        </div>
        <ul className="flex flex-wrap items-center gap-3">
          {HEAT_LEGEND.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span className="size-3 rounded-[3px] border border-line" style={{ background: l.color }} aria-hidden />
              {l.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
