"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import {
  DateRangeField,
  presetRange,
  type DateRangePreset,
} from "@/components/date-picker";
import type { CRMMetricsResponse, CRMSetup } from "@/lib/api-types";
import { DEFAULT_TIME_ZONE } from "@/lib/format";
import { FailureDialog, MetricTiles, StatusBar } from "./metric-tiles";
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
