"use client";

import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import type { CRMMetricsResponse, CRMSetup } from "@/lib/api-types";
import { FailureDialog, MetricTiles, StatusBar } from "./metric-tiles";

type Period = "7d" | "30d" | "all";

const PERIODS: { id: Period; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All" },
];

function windowFor(period: Period): { from: string; to: string } {
  const to = new Date();
  if (period === "all") return { from: "", to: to.toISOString() };
  const days = period === "7d" ? 7 : 30;
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
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
  const [period, setPeriod] = useState<Period>("30d");
  const [metrics, setMetrics] = useState<CRMMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const connected = Boolean(setup?.connected);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = windowFor(period);
    engageApi
      .crmMetrics(from, to)
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
          <button
            type="button"
            onClick={onSettings}
            className="text-[12.5px] font-medium text-brand hover:underline"
          >
            {connected ? "Settings" : "Connect"}
          </button>
        </div>
        <div
          className="inline-flex shrink-0 rounded-lg border border-line bg-surface-2 p-0.5"
          role="group"
          aria-label="Period"
        >
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={period === p.id}
              onClick={() => setPeriod(p.id)}
              className={`h-6 rounded-md px-2.5 text-[12px] ${
                period === p.id
                  ? "bg-surface font-semibold text-ink shadow-sm"
                  : "text-ink-2"
              }`}
            >
              {p.label}
            </button>
          ))}
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
