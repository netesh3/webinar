"use client";

import { MaterialIcon } from "@/components/icons";
import type { CRMMetricsResponse } from "@/lib/api-types";

/* The five numbers and the status bar. Shared by the WhatsApp page and, later,
 * the compact card on an ended webinar. */

export function formatRupees(micros: number): string {
  const n = micros / 1_000_000;
  if (!Number.isFinite(n) || n === 0) return "₹0";
  return `₹${n.toFixed(2)}`;
}

function share(part: number, whole: number): string {
  if (!whole) return "";
  return `${Math.round((part / whole) * 100)}%`;
}

export function MetricTiles({
  metrics,
  compact = false,
  onSeeWhy,
}: {
  metrics: CRMMetricsResponse;
  compact?: boolean;
  onSeeWhy?: () => void;
}) {
  const deliveredOfSent = share(metrics.delivered, metrics.sent);
  const readOfDelivered = share(metrics.read, metrics.delivered);
  const pad = compact ? "px-3.5 py-2.5" : "px-4 py-3";
  const figure = compact ? "text-[19px]" : "text-[22px]";
  const tiles: {
    icon: string;
    label: string;
    value: string;
    hint: string;
    extra?: string;
    bad?: boolean;
    seeWhy?: boolean;
  }[] = [
    {
      icon: "send",
      label: "Sent",
      value: String(metrics.sent),
      hint: "messages, all webinars",
    },
    {
      icon: "done_all",
      label: "Delivered",
      value: String(metrics.delivered),
      extra: deliveredOfSent,
      hint: "reached their phone",
    },
    {
      icon: "visibility",
      label: "Read",
      value: String(metrics.read),
      extra: readOfDelivered,
      hint: "of delivered",
    },
    {
      icon: "error",
      label: "Failed",
      value: String(metrics.failed),
      hint: "didn't arrive",
      bad: metrics.failed > 0,
      seeWhy: metrics.failed > 0,
    },
    {
      icon: "payments",
      label: "Cost",
      value: formatRupees(metrics.costMicros),
      hint: metrics.costEstimated ? "about · Meta's rate card" : "Meta bills your account",
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t, i) => (
        <div
          key={t.label}
          className={`${pad} min-w-0 border-line lg:border-l ${i === 0 ? "lg:border-l-0" : ""} ${
            t.bad ? "bg-warn-soft" : ""
          }`}
        >
          <div
            className={`flex items-center gap-1 text-[12px] font-medium ${
              t.bad ? "text-warn" : "text-ink-2"
            }`}
          >
            <MaterialIcon
              name={t.icon}
              className={`!text-[15px] ${t.bad ? "text-warn" : "text-ink-3"}`}
            />
            {t.label}
          </div>
          <p
            className={`mt-1 font-semibold tabular-nums leading-tight ${figure} ${
              t.bad ? "text-warn" : "text-ink"
            }`}
          >
            {t.label === "Cost" && metrics.costEstimated && metrics.costMicros > 0 && (
              <span className="mr-1 text-[13px] font-medium text-ink-3">about</span>
            )}
            {t.value}
            {t.extra && (
              <span className="ml-1.5 text-[13px] font-medium text-ink-3">{t.extra}</span>
            )}
          </p>
          <p className="mt-0.5 truncate text-[11.5px] text-ink-3">
            {t.hint}
            {t.seeWhy && onSeeWhy && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={onSeeWhy}
                  className="font-medium text-brand hover:underline"
                >
                  See why
                </button>
              </>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

export function StatusBar({ metrics }: { metrics: CRMMetricsResponse }) {
  const read = metrics.read;
  const deliveredOnly = Math.max(0, metrics.delivered - metrics.read);
  const failed = metrics.failed;
  const pending = Math.max(0, metrics.sent - metrics.delivered - metrics.failed);
  const parts = [
    { key: "read", n: read, label: `Read ${read}`, bar: "bg-ok", swatch: "bg-ok" },
    {
      key: "delivered",
      n: deliveredOnly,
      label: `Delivered, not read ${deliveredOnly}`,
      bar: "bg-[#9fd8b8]",
      swatch: "bg-[#9fd8b8]",
    },
    {
      key: "failed",
      n: failed,
      label: `Failed ${failed}`,
      bar: "bg-[#e0a54a]",
      swatch: "bg-[#e0a54a]",
    },
    {
      key: "pending",
      n: pending,
      label: `On the way ${pending}`,
      bar: "bg-line-2",
      swatch: "bg-line-2",
    },
  ].filter((p) => p.n > 0);
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3.5 border-t border-line px-4 py-2.5">
      <div className="flex h-2 min-w-[8rem] flex-1 gap-0.5 overflow-hidden rounded-full bg-surface-2">
        {parts.map((p) => (
          <i key={p.key} className={p.bar} style={{ flex: p.n }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-3.5 text-[11.5px] text-ink-3">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-[2px] ${p.swatch}`} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}
