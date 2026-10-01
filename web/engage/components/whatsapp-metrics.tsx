"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { DateRangeField } from "@/components/date-picker";
import type { CRMMetricsResponse, CRMSetup } from "@/lib/api-types";
import { DEFAULT_TIME_ZONE, instantToZoned } from "@/lib/format";
import { FailureDialog, MetricTiles, StatusBar } from "./metric-tiles";
import { beginWhatsAppMetrics } from "../whatsapp-boot";

/* 7 days and 30 days stay rolling windows — that is what the page already
 * asked for. This month and Custom are calendar dates, which GET /crm/metrics
 * already accepts (YYYY-MM-DD, the whole UTC day). "30 days" is already the
 * last 30 days, so it is not offered twice. */

type Period =
  | { id: "7d" | "30d" | "all" | "month" }
  | { id: "custom"; from: string; to: string };

const PRESETS: { id: "7d" | "30d" | "month" | "all"; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "all", label: "All" },
];

function windowFor(period: Period): { from: string; to: string } | null {
  const to = new Date();
  if (period.id === "all") return { from: "", to: to.toISOString() };
  if (period.id === "7d" || period.id === "30d") {
    const days = period.id === "7d" ? 7 : 30;
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  if (period.id === "month") {
    const { date } = instantToZoned(to.toISOString(), DEFAULT_TIME_ZONE);
    const [y, m] = date.split("-");
    return { from: `${y}-${m}-01`, to: date };
  }
  if (period.id !== "custom" || !period.from || !period.to) return null;
  return { from: period.from, to: period.to };
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
  const [period, setPeriod] = useState<Period>({ id: "30d" });
  const [metrics, setMetrics] = useState<CRMMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const connected = Boolean(setup?.connected);

  useEffect(() => {
    let cancelled = false;
    const bounds = windowFor(period);
    if (!bounds) return;
    const { from, to } = bounds;
    // The first window was asked for when the page mounted, beside the login
    // check. Changing the period is a new question and asks again.
    const load =
      period.id === "30d"
        ? beginWhatsAppMetrics()
        : engageApi.crmMetrics(from, to);
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
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={period.id === p.id}
              onClick={() => setPeriod({ id: p.id })}
              className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[12px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                period.id === p.id
                  ? "border-brand-line bg-brand-soft font-semibold text-brand"
                  : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2"
              }`}
            >
              {p.label}
            </button>
          ))}
          <DateRangeField
            appearance="chip"
            presets={false}
            pressed={period.id === "custom"}
            timeZone={DEFAULT_TIME_ZONE}
            ariaLabel="Custom date range"
            from={period.id === "custom" ? period.from : ""}
            to={period.id === "custom" ? period.to : ""}
            onChange={(from, to) =>
              setPeriod(from && to ? { id: "custom", from, to } : { id: "30d" })
            }
          />
        </div>
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
