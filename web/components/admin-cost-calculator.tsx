"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  calculateCost,
  DEFAULT_INPUTS,
  RECORDING_STORES,
  type CostInputs,
  type RecordingStore,
} from "@/lib/cost-calculator";
import { Disclosure, Toggle } from "./controls";
import { Card, SectionTitle, Stat } from "./ui";

/* The admin Cost calculator: what one coach costs us a month, from how they run webinars.
 *
 * The arithmetic is lib/cost-calculator.ts; this is its inputs and a breakdown. Prices are
 * inputs too, folded away under "Prices and rates", so a new quote can be tried without a
 * deploy. Inputs persist in this browser only — it is a scratchpad, not a setting. */

const STORAGE_KEY = "admin-cost-calculator";

function loadInputs(): CostInputs {
  if (typeof window === "undefined") return DEFAULT_INPUTS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return saved && typeof saved === "object" ? { ...DEFAULT_INPUTS, ...saved } : DEFAULT_INPUTS;
  } catch {
    return DEFAULT_INPUTS;
  }
}

export function AdminCostCalculator() {
  // Read once, at first render: this tab only ever renders in the browser, after a click
  // (AdminScreen opens on the dashboard), so there is no server render to disagree with.
  const [inputs, setInputs] = useState<CostInputs>(loadInputs);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
    } catch {
      // Private mode or a full quota: the calculator still works, it just forgets.
    }
  }, [inputs]);

  const set = <K extends keyof CostInputs>(key: K, value: CostInputs[K]) =>
    setInputs((prev) => ({ ...prev, [key]: value }));
  const r = useMemo(() => calculateCost(inputs), [inputs]);
  const rate = inputs.inrPerUsd > 0 ? inputs.inrPerUsd : 1;
  const inr = (usd: number) =>
    `₹${(usd * rate).toLocaleString("en-IN", { maximumFractionDigits: usd * rate < 10 ? 2 : 0 })}`;
  const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

  const num = (key: keyof CostInputs, label: string, opts: { step?: number; suffix?: string; hint?: string } = {}) => (
    <NumberField
      label={label}
      value={inputs[key] as number}
      onChange={(v) => set(key, v as never)}
      step={opts.step}
      suffix={opts.suffix}
      hint={opts.hint}
    />
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="grid content-start gap-5">
        <Card className="p-4">
          <SectionTitle>Usage per coach</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {num("webinarsPerMonth", "Webinars a month")}
            {num("hoursPerWebinar", "Hours per webinar", { step: 0.25 })}
            {num("viewersPerWebinar", "Viewers per webinar")}
            {num("watchPercent", "Average watch", { suffix: "%", hint: "Share of the session the average viewer stays for." })}
            {num("onStage", "People on stage", { hint: "Host and panelists together." })}
          </div>
        </Card>

        <Card className="p-4">
          <SectionTitle>Delivery</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Audience delivery"
              value={inputs.delivery}
              onChange={(v) => set("delivery", v as CostInputs["delivery"])}
              options={[
                { id: "edge", label: "Edge (LL-HLS via CDN)" },
                { id: "webrtc", label: "WebRTC (video room)" },
              ]}
            />
            <SelectField
              label="Video server"
              value={inputs.videoServer}
              onChange={(v) => set("videoServer", v as CostInputs["videoServer"])}
              options={[
                { id: "gcp", label: "Mumbai (GCP)" },
                { id: "hetzner", label: "Hetzner (traffic included)" },
              ]}
            />
            {inputs.delivery === "edge" && (
              <>
                {num("edgeVideoKbps", "Edge video bitrate", { suffix: "kbps" })}
                {num("edgeAudioKbps", "Edge audio bitrate", { suffix: "kbps" })}
              </>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <SectionTitle>Recordings</SectionTitle>
          <Toggle
            checked={inputs.recording}
            onChange={(v) => set("recording", v)}
            label="Record every webinar"
          />
          {inputs.recording && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Stored in"
                value={inputs.recordingStore}
                onChange={(v) => set("recordingStore", v as RecordingStore)}
                options={(Object.keys(RECORDING_STORES) as RecordingStore[]).map((id) => ({
                  id,
                  label: `${RECORDING_STORES[id].label} · $${RECORDING_STORES[id].perGbMonth}/GB-mo${
                    RECORDING_STORES[id].egressPerGb ? `, $${RECORDING_STORES[id].egressPerGb}/GB out` : ", free egress"
                  }`,
                }))}
              />
              {num("recordingMonths", "Kept for", { suffix: "months" })}
              {num("replayHoursPerRecording", "Replay hours per recording", { hint: "All viewers together." })}
              {num("recordingGbPerHour", "Size of a recorded hour", { step: 0.25, suffix: "GB" })}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <SectionTitle>Price charged</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {num("priceInr", "Plan price a month", { suffix: "₹" })}
            {num("paymentFeePercent", "Payment fee", { step: 0.1, suffix: "%" })}
          </div>
          <div className="mt-3">
            <Toggle
              checked={inputs.priceIncludesGst}
              onChange={(v) => set("priceIncludesGst", v)}
              label="Price includes 18% GST"
            />
          </div>
        </Card>

        <Card className="p-4">
          <Disclosure summary="Prices and rates">
            <div className="grid gap-3 sm:grid-cols-2">
              {num("inrPerUsd", "Rupees per dollar")}
              {num("cdnPerGb", "CDN per GB", { step: 0.001, suffix: "$" })}
              {num("egressPerGb", "GCP egress per GB", { step: 0.01, suffix: "$" })}
              {num("originPulls", "CDN locations pulling the origin")}
              {num("workerPerHour", "Egress worker per hour", { step: 0.01, suffix: "$" })}
              {num("sfuPerHour", "SFU per hour", { step: 0.01, suffix: "$" })}
              {num("warmupMinutes", "Warm-up per webinar", { suffix: "min" })}
              {num("webrtcViewerMbps", "WebRTC viewer", { step: 0.1, suffix: "Mbps" })}
              {num("apiMbPerViewerHour", "API traffic per viewer-hour", { step: 0.5, suffix: "MB" })}
            </div>
            <button
              type="button"
              onClick={() => setInputs(DEFAULT_INPUTS)}
              className="mt-3 text-[12.5px] font-medium text-brand hover:underline"
            >
              Reset everything to defaults
            </button>
          </Disclosure>
        </Card>
      </div>

      <div className="grid content-start gap-5 lg:sticky lg:top-4">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Cost a month" value={inr(r.monthUsd)} note={usd(r.monthUsd)} tone="brand" />
          <Stat label="Per webinar" value={inr(r.webinarUsd)} note={usd(r.webinarUsd)} />
          <Stat
            label="Per viewer-hour"
            value={inr(r.perViewerHourUsd)}
            note={`${Math.round(r.viewerHours).toLocaleString("en-IN")} viewer-hours a month`}
          />
          <Stat
            label="Margin"
            value={r.marginPercent == null ? "—" : `${Math.round(r.marginPercent)}%`}
            note={
              r.marginUsd == null || r.netRevenueUsd == null
                ? "Enter a plan price"
                : `${inr(r.marginUsd)} of ${inr(r.netRevenueUsd)} net`
            }
            tone={r.marginPercent == null ? "neutral" : r.marginPercent < 30 ? "live" : r.marginPercent < 50 ? "warn" : "ok"}
          />
        </div>

        <Card className="overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line bg-surface-2 text-[11.5px] text-ink-3">
              <tr>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 text-right font-medium">A month</th>
                <th className="px-4 py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.key} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-ink">{l.label}</div>
                    <div className="text-[11.5px] text-ink-3">{l.note}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                    {inr(l.usd)}
                    <div className="text-[11.5px] text-ink-3">{usd(l.usd)}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">
                    {r.monthUsd > 0 ? `${Math.round((l.usd / r.monthUsd) * 100)}%` : "—"}
                  </td>
                </tr>
              ))}
              {r.lines.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-ink-3">
                    Nothing to bill yet. Enter some usage.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <p className="text-[12px] leading-relaxed text-ink-3">
          Estimates at list prices, per coach. Not included: the database, Cloud Run&apos;s own
          compute, the Hetzner box (a fixed monthly cost shared by every coach on it), and
          WhatsApp messages, which Meta bills to the coach.
        </p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <span className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step={step}
          className="field w-full tabular-nums"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
        {suffix && <span className="shrink-0 text-[12.5px] text-ink-3">{suffix}</span>}
      </span>
    </Field>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <Field label={label}>
      <select className="field w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
