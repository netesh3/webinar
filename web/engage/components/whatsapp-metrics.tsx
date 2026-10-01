"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import {
  DateRangeField,
  presetRange,
  type DateRangePreset,
} from "@/components/date-picker";
import { SearchIcon } from "@/components/icons";
import { SortHeader, useSort } from "@/components/sort-header";
import { ListPager } from "@/components/ui";
import { api } from "@/lib/api";
import type {
  CRMMetricsResponse,
  CRMSetup,
  CRMWebinarMetricsResponse,
  Webinar,
} from "@/lib/api-types";
import { DEFAULT_TIME_ZONE, formatDayShort } from "@/lib/format";
import { sortBy, type SortDir } from "@/lib/table-sort";
import { FailureDialog, MetricTiles, StatusBar, formatRupees } from "./metric-tiles";
import { whatsAppMetricsFlightFor } from "../whatsapp-boot";

/* The same range field as the webinar lists. 7 days, 30 days, and This month
 * are inclusive calendar dates in IST, which GET /crm/metrics already accepts
 * (YYYY-MM-DD, the whole UTC day). All clears the range: the request omits
 * from and sends to=now, because omitting both is the server's last-30-days
 * default, not all time. */

const PERIOD_PRESETS: DateRangePreset[] = [
  { id: "7d", label: "7 days", fromOffset: -6, toOffset: 0 },
  { id: "30d", label: "30 days", fromOffset: -29, toOffset: 0 },
  { id: "month", label: "This month", fromMonthStart: true, toOffset: 0 },
  { id: "all", label: "All", clear: true },
];

function metricQuery(from: string, to: string): { from: string; to: string } {
  if (!from && !to) return { from: "", to: new Date().toISOString() };
  return { from, to };
}

const empty: CRMMetricsResponse = {
  to: "",
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  costMicros: 0,
  costEstimated: false,
  currency: "INR",
  failures: [],
};

/* Connected line, the period switch, the five tiles and See why. */
export function WhatsAppMetrics({
  setup,
  onSettings,
}: {
  setup: CRMSetup | null;
  onSettings: () => void;
}) {
  const [period, setPeriod] = useState(() =>
    presetRange(PERIOD_PRESETS[1], DEFAULT_TIME_ZONE),
  );
  const [metrics, setMetrics] = useState<CRMMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const connected = Boolean(setup?.connected);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = metricQuery(period.from, period.to);
    // The first window was asked for when the page mounted, beside the login
    // check. A later range is a new question and asks again. Reuse the
    // prefetch only when it is the same calendar window the card is showing.
    const load =
      whatsAppMetricsFlightFor(from, to) ?? engageApi.crmMetrics(from, to);
    load
      .then((res) => {
        if (!cancelled) {
          setMetrics(res);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load these numbers.");
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const shown = metrics ?? empty;

  return (
    <section className="mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-ink-2">
          {connected ? (
            <>
              <span className="size-2 shrink-0 rounded-full bg-ok ring-[3px] ring-ok/15" />
              <b className="font-semibold text-ink">Connected</b>
              <span className="truncate">
                {setup?.displayPhone || "your number"}
                {setup?.verifiedName ? ` (${setup.verifiedName})` : ""}
              </span>
              <span className="text-[12px] text-ink-3">· messages come from your number</span>
            </>
          ) : (
            <>
              <span className="size-2 shrink-0 rounded-full bg-ink-3" />
              <b className="font-semibold text-ink">Not connected</b>
              <span className="text-[12px] text-ink-3">
                Connect your number and these messages go out from it.
              </span>
            </>
          )}
          {connected ? (
            <Link
              href="/settings#integrations"
              className="text-[12.5px] font-medium text-brand hover:underline"
            >
              Settings
            </Link>
          ) : (
            <button
              type="button"
              onClick={onSettings}
              className="text-[12.5px] font-medium text-brand hover:underline"
            >
              Connect
            </button>
          )}
        </div>
        <DateRangeField
          from={period.from}
          to={period.to}
          presets={PERIOD_PRESETS}
          timeZone={DEFAULT_TIME_ZONE}
          size="sm"
          emptyLabel="All"
          ariaLabel="Metrics date range"
          onChange={(from, to) => setPeriod({ from, to })}
        />
      </div>
      {error && !metrics ? (
        <p className="px-4 py-6 text-[13px] text-ink-3">{error}</p>
      ) : metrics === null ? (
        <div className="grid place-items-center py-8">
          <Spinner />
        </div>
      ) : (
        <>
          <MetricTiles metrics={shown} onSeeWhy={() => setWhy(true)} />
          <StatusBar metrics={shown} />
        </>
      )}
      {why && (
        <FailureDialog failures={shown.failures} onClose={() => setWhy(false)} />
      )}
    </section>
  );
}

/* Metrics tab: the same tiles and date field, then one search row, then each
 * webinar. The date field still chooses the account totals. It also limits
 * which webinars are listed, by the day they start. */

const PAGE = 8;

type MetricSort = "webinar" | "sent" | "delivered" | "read" | "failed" | "cost";

function dayKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function share(part: number, whole: number): string {
  if (!whole) return "";
  return `${Math.round((part / whole) * 100)}%`;
}

export function WhatsAppMetricsView() {
  const [period, setPeriod] = useState(() =>
    presetRange(PERIOD_PRESETS[1], DEFAULT_TIME_ZONE),
  );
  const [query, setQuery] = useState("");
  const [metrics, setMetrics] = useState<CRMMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [byWebinar, setByWebinar] = useState<
    Map<string, CRMWebinarMetricsResponse | null>
  >(() => new Map());
  const [page, setPage] = useState(0);
  const { sort, onSort } = useSort<MetricSort>({
    defaultDir: {
      webinar: "asc",
      sent: "desc",
      delivered: "desc",
      read: "desc",
      failed: "desc",
      cost: "desc",
    },
  });

  useEffect(() => {
    let cancelled = false;
    const { from, to } = metricQuery(period.from, period.to);
    const load =
      whatsAppMetricsFlightFor(from, to) ?? engageApi.crmMetrics(from, to);
    load
      .then((res) => {
        if (!cancelled) {
          setMetrics(res);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load these numbers.");
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  useEffect(() => {
    let cancelled = false;
    api
      .hostWebinarsForPicker()
      .then((items) => {
        if (!cancelled) {
          setWebinars(items);
          setListError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWebinars([]);
          setListError("Could not load your webinars.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (webinars ?? []).filter((webinar) => {
      if (q && !webinar.topic.toLowerCase().includes(q)) return false;
      if (!period.from && !period.to) return true;
      const day = dayKey(webinar.startsAt);
      if (period.from && day < period.from) return false;
      if (period.to && day > period.to) return false;
      return true;
    });
  }, [webinars, query, period.from, period.to]);

  const ordered = useMemo(() => {
    if (!sort.key) {
      return [...filtered].sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    }
    const dir: SortDir = sort.dir;
    if (sort.key === "webinar") return sortBy(filtered, dir, (row) => row.topic, "string");
    const numberOf = (row: Webinar): number | null => {
      const stats = byWebinar.get(row.id);
      if (!stats) return null;
      if (sort.key === "sent") return stats.sent;
      if (sort.key === "delivered") return stats.delivered;
      if (sort.key === "read") return stats.read;
      if (sort.key === "failed") return stats.failed;
      return stats.costMicros;
    };
    return sortBy(filtered, dir, numberOf, "number");
  }, [filtered, sort, byWebinar]);

  const pages = Math.max(1, Math.ceil(ordered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const rows = ordered.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const rowKey = rows.map((row) => row.id).join("\n");

  useEffect(() => {
    const missing = rows.filter((row) => !byWebinar.has(row.id));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (row) => {
        try {
          return [row.id, await engageApi.crmWebinarMetrics(row.id)] as const;
        } catch {
          return [row.id, null] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setByWebinar((current) => {
        const next = new Map(current);
        for (const [id, stats] of pairs) next.set(id, stats);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // rows is derived; rowKey is the set of slugs on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKey]);

  const shown = metrics ?? empty;
  const start = ordered.length === 0 ? 0 : safePage * PAGE + 1;
  const end = Math.min(ordered.length, safePage * PAGE + rows.length);

  return (
    <div className="grid gap-3">
      <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        {error && !metrics ? (
          <p className="px-4 py-6 text-[13px] text-ink-3">{error}</p>
        ) : metrics === null ? (
          <div className="grid place-items-center py-8">
            <Spinner />
          </div>
        ) : (
          <>
            <MetricTiles metrics={shown} onSeeWhy={() => setWhy(true)} />
            <StatusBar metrics={shown} />
          </>
        )}
      </section>

      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search webinars</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search webinars"
            className="field h-9 w-full pl-8 text-[13px]"
          />
        </label>
        <DateRangeField
          from={period.from}
          to={period.to}
          presets={PERIOD_PRESETS}
          timeZone={DEFAULT_TIME_ZONE}
          size="sm"
          emptyLabel="All"
          ariaLabel="Metrics date range"
          onChange={(from, to) => {
            setPeriod({ from, to });
            setPage(0);
          }}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-ink-3">
                <SortHeader
                  label="Webinar"
                  active={sort.key === "webinar"}
                  dir={sort.dir}
                  hintDir="asc"
                  onSort={() => onSort("webinar")}
                  className="px-4 py-2.5 font-medium"
                />
                {(
                  [
                    ["sent", "Sent"],
                    ["delivered", "Delivered"],
                    ["read", "Read"],
                    ["failed", "Failed"],
                    ["cost", "Cost"],
                  ] as const
                ).map(([key, label]) => (
                  <SortHeader
                    key={key}
                    label={label}
                    active={sort.key === key}
                    dir={sort.dir}
                    hintDir="desc"
                    align="right"
                    onSort={() => onSort(key)}
                    className="px-3 py-2.5 text-right font-medium"
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {webinars === null ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center">
                    <Spinner className="inline size-5 text-ink-3" />
                  </td>
                </tr>
              ) : listError ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-3">
                    {listError}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-3">
                    No webinars in this range.
                  </td>
                </tr>
              ) : (
                rows.map((webinar) => {
                  const stats = byWebinar.get(webinar.id);
                  return (
                    <tr key={webinar.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-2.5">
                        <Link href={`/host/${webinar.id}`} className="hover:text-brand">
                          <b className="block font-semibold text-ink">{webinar.topic}</b>
                          <span className="text-[12px] text-ink-3">
                            {formatDayShort(webinar.startsAt, webinar.timeZone || DEFAULT_TIME_ZONE)}
                          </span>
                        </Link>
                      </td>
                      <MetricCell value={stats ? String(stats.sent) : stats === null ? "—" : ""} />
                      <MetricCell
                        value={stats ? String(stats.delivered) : stats === null ? "—" : ""}
                        hint={stats ? share(stats.delivered, stats.sent) : ""}
                      />
                      <MetricCell
                        value={stats ? String(stats.read) : stats === null ? "—" : ""}
                        hint={stats ? share(stats.read, stats.delivered) : ""}
                      />
                      <MetricCell value={stats ? String(stats.failed) : stats === null ? "—" : ""} />
                      <MetricCell
                        value={
                          stats
                            ? formatRupees(stats.costMicros)
                            : stats === null
                              ? "—"
                              : ""
                        }
                      />
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <ListPager
          layout="split"
          range="stack"
          className="border-t border-line px-4 py-2.5"
          page={safePage + 1}
          pages={pages}
          pageSize={PAGE}
          start={start}
          end={end}
          total={ordered.length}
          onPrevious={() => setPage((n) => Math.max(0, Math.min(n, pages - 1) - 1))}
          onNext={() => setPage((n) => Math.min(pages - 1, n + 1))}
        />
      </section>
      {why && (
        <FailureDialog failures={shown.failures} onClose={() => setWhy(false)} />
      )}
    </div>
  );
}

function MetricCell({ value, hint }: { value: string; hint?: string }) {
  return (
    <td className="px-3 py-2.5 text-right tabular-nums text-ink">
      {value === "" ? (
        <Spinner className="ml-auto size-3.5 text-ink-3" />
      ) : (
        <>
          {value}
          {hint && <i className="ml-1 text-[11.5px] font-medium text-ink-3 not-italic">{hint}</i>}
        </>
      )}
    </td>
  );
}
