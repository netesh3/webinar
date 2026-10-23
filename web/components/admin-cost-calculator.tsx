"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  calculateCost,
  calculatePricing,
  compareProviders,
  DEFAULT_INPUTS,
  featureRows,
  fixedRows,
  GROUP_LABELS,
  PLAN_CAPS,
  PRESETS,
  PROVIDERS,
  quotaWorstCase,
  RECORDING_STORES,
  shareMbps,
  withDefaults,
  type CostGroup,
  type CostInputs,
  type FeatureKey,
  type Preset,
  type Provider,
  type ProviderRates,
  type RecordingStore,
} from "@/lib/cost-calculator";
import { Disclosure, Toggle } from "./controls";
import { Card, SectionTitle, Stat } from "./ui";

/* The admin Cost calculator, around one question: if every coach gets these features and
 * uses them this much, what does it cost us a month for N coaches?
 *
 * The main view is the coach count, the provider, and a feature table: each feature on or off
 * with one or two usage inputs in plain units, and its cost per coach and for all coaches.
 * The fixed platform costs (servers for the coach count's peak, the database, the API host)
 * sit under it, then the totals, the suggested minimum price and the margin at the current
 * price. Every technical rate (bitrates, $/GB, AV1 and TURN shares, share bitrates, token
 * counts, provider prices) is in the collapsed Advanced assumptions, with the per-provider
 * comparison and the line-by-line breakdown.
 *
 * The arithmetic is lib/cost-calculator.ts. Inputs persist in this browser only — it is a
 * scratchpad, not a setting. */

const STORAGE_KEY = "admin-cost-calculator-v2";
const GROUP_ORDER: CostGroup[] = ["delivery", "meetings", "recording", "ai", "messaging", "fixed", "info"];
const PROVIDER_NAMES: Record<Provider, string> = { gcp: "GCP", hetzner: "Hetzner", do: "DigitalOcean" };

// Also read by the Cost by host tab (admin-host-costs.tsx), which prices usage at these rates.
export function loadInputs(): CostInputs {
  if (typeof window === "undefined") return DEFAULT_INPUTS;
  try {
    return withDefaults(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return DEFAULT_INPUTS;
  }
}

type NumOpts = { step?: number; suffix?: string; hint?: string };

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
  const setFeature = (key: FeatureKey, on: boolean) =>
    setInputs((prev) => ({ ...prev, features: { ...prev.features, [key]: on } }));
  const setRate = <K extends keyof ProviderRates>(key: K, value: ProviderRates[K]) =>
    setInputs((prev) => ({
      ...prev,
      providers: { ...prev.providers, [prev.provider]: { ...prev.providers[prev.provider], [key]: value } },
    }));
  const r = useMemo(() => calculateCost(inputs), [inputs]);
  const compare = useMemo(() => compareProviders(inputs), [inputs]);
  const pricing = useMemo(() => calculatePricing(inputs), [inputs]);
  const rows = useMemo(() => featureRows(r, inputs.features), [r, inputs.features]);
  const fixed = useMemo(() => fixedRows(r), [r]);
  const worst = useMemo(() => quotaWorstCase(inputs), [inputs]);
  const rates = inputs.providers[inputs.provider];
  const rate = inputs.inrPerUsd > 0 ? inputs.inrPerUsd : 1;
  const inr = (usd: number) => {
    const v = usd * rate;
    const s = `₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 0 })}`;
    return v < 0 ? `−${s}` : s;
  };
  const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(Math.abs(n) < 10 ? 2 : 0)}`;
  const fine = (n: number) => `₹${(n * rate).toFixed(2)}`;
  const count = (n: number) => Math.round(n).toLocaleString("en-IN");

  const num = (key: keyof CostInputs, label: string, opts: NumOpts = {}) => (
    <NumberField label={label} value={inputs[key] as number} onChange={(v) => set(key, v as never)} {...opts} />
  );
  const mini = (key: keyof CostInputs, label: string, opts: { step?: number; onChange?: (v: number) => void } = {}) => (
    <MiniField
      key={key}
      label={label}
      value={inputs[key] as number}
      step={opts.step}
      onChange={opts.onChange ?? ((v) => set(key, v as never))}
    />
  );
  const rateNum = (key: keyof ProviderRates, label: string, opts: NumOpts = {}) => (
    <NumberField label={label} value={rates[key] as number} onChange={(v) => setRate(key, v as never)} {...opts} />
  );
  const name = PROVIDER_NAMES[inputs.provider];

  // The one or two plain usage inputs each feature row carries.
  const usage: Record<FeatureKey, ReactNode> = {
    webinars: [mini("webinarsPerMonth", "a month"), mini("hoursPerWebinar", "hours each", { step: 0.25 }), mini("viewersPerWebinar", "attendees")],
    meetings: [mini("meetingsPerMonth", "a month"), mini("hoursPerMeeting", "hours each", { step: 0.25 }), mini("participantsPerMeeting", "participants")],
    recording: [
      mini("recordWebinarsPercent", "% of sessions", {
        onChange: (v) => setInputs((prev) => ({ ...prev, recordWebinarsPercent: v, recordMeetingsPercent: v })),
      }),
      mini("keepLongerPercent", "% kept longer"),
    ],
    simulive: [mini("simulivesPerMonth", "a month"), mini("viewersPerSimulive", "viewers")],
    captions: [mini("captionsPercent", "% of sessions")],
    ai: [mini("questionsPerSession", "questions a session")],
    youtube: [mini("youtubePercent", "% of webinars")],
    messaging: [mini("emailsPerRegistrant", "emails a registrant")],
    push: [mini("pushReplacePercent", "% of reminders")],
    turn: [mini("turnPercent", "% relayed")],
    av1: [mini("av1PublisherPercent", "% of publishers")],
    edgeShare: (
      <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
        <select
          className="field py-1 text-[12.5px]"
          value={String(inputs.edgeShareKbps)}
          onChange={(e) => set("edgeShareKbps", Number(e.target.value))}
        >
          <option value="1300">1300 kbps</option>
          <option value="1600">1600 kbps</option>
        </select>
        while sharing
      </label>
    ),
  };

  const featureTotal = rows.reduce((t, x) => t + x.usd, 0);
  const fixedTotal = fixed.reduce((t, x) => t + x.usd, 0);
  const cell = "px-3 py-2 align-top";
  const money = "px-3 py-2 text-right align-top tabular-nums whitespace-nowrap";

  return (
    <div className="grid gap-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="w-44">
            {num("coaches", "Coaches this month", { hint: "Fixed costs and the transfer pool are shared." })}
          </div>
          <div className="grid gap-1">
            <span className="text-[12.5px] font-medium text-ink-2">Video provider</span>
            <div
              role="radiogroup"
              aria-label="Video provider"
              className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5"
            >
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={inputs.provider === p}
                  onClick={() => set("provider", p)}
                  className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium ${
                    inputs.provider === p ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
                  }`}
                >
                  {PROVIDER_NAMES[p]}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-1">
            <span className="text-[12.5px] font-medium text-ink-2">Usage presets</span>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PRESETS) as Preset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setInputs((prev) => ({ ...prev, ...PRESETS[p].usage }))}
                  className="rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
                >
                  {PRESETS[p].label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-2 text-[11.5px] text-ink-3">
          Light: 4 webinars × 1 h × 100, 10 meetings × 5. Typical: 8 × 1.5 h × 300, 25 × 10. Heavy: 12 × 2 h ×
          500, 40 × 15. Presets set the usage only.
        </p>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line bg-surface-2 text-[11.5px] text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">Included</th>
                <th className="px-3 py-2 font-medium">Feature</th>
                <th className="px-3 py-2 font-medium">Usage per coach</th>
                <th className="px-3 py-2 text-right font-medium">Per coach a month</th>
                <th className="px-3 py-2 text-right font-medium">All {r.coaches} coaches</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const notes = row.lines.filter((l) => l.info).map((l) => l.note);
                return (
                  <tr key={row.key} className={`border-b border-line ${row.on ? "" : "text-ink-3"}`}>
                    <td className={cell}>
                      <input
                        type="checkbox"
                        className="mt-1 size-4 accent-brand"
                        checked={row.on}
                        onChange={(e) => setFeature(row.key, e.target.checked)}
                        aria-label={`Include ${row.label}`}
                      />
                    </td>
                    <td className={cell}>
                      <div className={`font-medium ${row.on ? "text-ink" : ""}`}>{row.label}</div>
                      <div className="text-[11.5px] text-ink-3" title={notes.join("\n") || undefined}>
                        {row.hint}
                      </div>
                    </td>
                    <td className={cell}>
                      <div className={`flex flex-wrap gap-2 ${row.on ? "" : "pointer-events-none opacity-50"}`}>
                        {usage[row.key]}
                      </div>
                    </td>
                    <td className={money}>{row.on ? inr(row.usd) : "Off"}</td>
                    <td className={money}>{row.on ? inr(row.platformUsd) : "—"}</td>
                  </tr>
                );
              })}
              <tr className="border-b border-line bg-surface-2 font-semibold">
                <td className={cell} />
                <td className={cell} colSpan={2}>
                  Features total
                </td>
                <td className={money}>{inr(featureTotal)}</td>
                <td className={money}>{inr(featureTotal * r.coaches)}</td>
              </tr>
              <tr className="border-b border-line">
                <td className="px-3 pt-4 pb-1 text-[11.5px] font-semibold text-ink-2" colSpan={5}>
                  Fixed platform costs (servers sized for {r.coaches} coaches: peak ≈ {r.servers.peakSessions} sessions
                  and {r.servers.peakEdgeWebinars} edge webinars at once)
                </td>
              </tr>
              {fixed.map((f) => (
                <tr key={f.key} className="border-b border-line">
                  <td className={cell} />
                  <td className={cell} colSpan={2}>
                    <div className="font-medium text-ink">{f.label}</div>
                    <div className="text-[11.5px] text-ink-3">{f.note}</div>
                  </td>
                  <td className={money}>{inr(f.usd)}</td>
                  <td className={money}>{inr(f.platformUsd)}</td>
                </tr>
              ))}
              <tr className="border-b border-line bg-surface-2 font-semibold">
                <td className={cell} />
                <td className={cell} colSpan={2}>
                  Fixed total
                </td>
                <td className={money}>{inr(fixedTotal)}</td>
                <td className={money}>{inr(fixedTotal * r.coaches)}</td>
              </tr>
              <tr className="bg-surface-2 text-[14px] font-semibold text-ink">
                <td className={cell} />
                <td className={cell} colSpan={2}>
                  Total a month
                </td>
                <td className={money}>{inr(r.monthUsd)}</td>
                <td className={money}>{inr(r.platformMonthUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="px-3 py-2 text-[11.5px] text-ink-3">
          Servers: sessions are assumed spread over {count(inputs.busyHoursPerMonth)} busy hours a month; a box carries{" "}
          {count(inputs.boxSessionCapacity)} sessions at once and renders one edge mix, so the peak sets the extra boxes
          and render workers. {r.pool.percent == null
            ? `No transfer pool on ${name}: every GB bills.`
            : `Transfer pool ${Math.round(r.pool.percent)}% used (${count(r.pool.usedGb)} of ${count(r.pool.includedGb)} GB); within it, transfer is ₹0.`}{" "}
          Change these in Advanced assumptions.
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Total a month"
          value={inr(r.platformMonthUsd)}
          note={`${r.coaches} coaches · ${usd(r.platformMonthUsd)}`}
          tone="brand"
        />
        <Stat label="Per coach, fixed share included" value={inr(r.monthUsd)} note={usd(r.monthUsd)} />
        <Stat
          label={`Suggested minimum price (${inputs.targetMarginPercent}% margin)`}
          value={`₹${count(pricing.minimumInr)}`}
          note={`Break-even ₹${count(pricing.breakEvenInr)}; ₹${count(inputs.overheadInr)} overhead${inputs.priceIncludesGst ? ", GST" : ""} and the fee included`}
        />
        <Stat
          label={`Margin at ₹${count(inputs.priceInr)}`}
          value={pricing.currentMarginPercent == null ? "—" : `${Math.round(pricing.currentMarginPercent)}%`}
          note={
            pricing.currentMarginInr == null
              ? "Enter a plan price in Advanced"
              : `₹${count(pricing.currentMarginInr)} a coach a month, overhead included`
          }
          tone={
            pricing.currentMarginPercent == null
              ? "neutral"
              : pricing.currentMarginPercent < 30
                ? "live"
                : pricing.currentMarginPercent < 50
                  ? "warn"
                  : "ok"
          }
        />
      </div>

      <Card className="p-4">
        <Disclosure summary="Advanced assumptions: rates, bitrates, provider comparison and every line">
          <div className="mt-3 grid gap-5">
            <div>
              <SectionTitle>Per-provider comparison</SectionTitle>
              <p className="text-[11.5px] text-ink-3">
                The same usage on each. Switching swaps the SFU box, workers, included transfer and overage, and the
                API host. The last columns are what screen share, TURN, AV1 and YouTube add (or save) per coach.
              </p>
              <div className="overflow-x-auto">
                <table className="mt-2 w-full text-left text-[12.5px]">
                  <thead className="text-[11.5px] text-ink-3">
                    <tr>
                      <th className="py-1 font-medium">Provider</th>
                      <th className="py-1 text-right font-medium">Per coach</th>
                      <th className="py-1 text-right font-medium">Platform</th>
                      <th className="py-1 text-right font-medium">Minimum price</th>
                      <th className="py-1 text-right font-medium">Attendee-hour</th>
                      <th className="py-1 text-right font-medium">Participant-hour</th>
                      <th className="py-1 text-right font-medium">Pool used</th>
                      <th className="py-1 text-right font-medium">Share</th>
                      <th className="py-1 text-right font-medium">TURN</th>
                      <th className="py-1 text-right font-medium">AV1</th>
                      <th className="py-1 text-right font-medium">YouTube</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PROVIDERS.map((p) => {
                      const c = compare[p];
                      return (
                        <tr
                          key={p}
                          className={`border-t border-line ${p === inputs.provider ? "font-semibold text-ink" : "text-ink-2"}`}
                        >
                          <td className="py-1.5">{inputs.providers[p].label}</td>
                          <td className="py-1.5 text-right tabular-nums">{inr(c.monthUsd)}</td>
                          <td className="py-1.5 text-right tabular-nums">{inr(c.platformMonthUsd)}</td>
                          <td className="py-1.5 text-right tabular-nums">
                            ₹{count(calculatePricing({ ...inputs, provider: p }).minimumInr)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{fine(c.perViewerHourUsd)}</td>
                          <td className="py-1.5 text-right tabular-nums">{fine(c.perParticipantHourUsd)}</td>
                          <td className="py-1.5 text-right tabular-nums">
                            {c.pool.percent == null ? "no pool" : `${Math.round(c.pool.percent)}%`}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{inr(c.deltas.shareUsd)}</td>
                          <td className="py-1.5 text-right tabular-nums">{inr(c.deltas.turnUsd)}</td>
                          <td className="py-1.5 text-right tabular-nums">{inr(c.deltas.av1Usd)}</td>
                          <td className="py-1.5 text-right tabular-nums">{inr(c.deltas.youtubeUsd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <div className="grid content-start gap-5">
                <Card className="p-4">
                  <SectionTitle>Webinars and servers</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("watchPercent", "Average watch", {
                      suffix: "%",
                      hint: "Share of the session the average attendee stays for.",
                    })}
                    {num("onStage", "People on stage", { hint: "Host and panelists together." })}
                    <SelectField
                      label="Audience delivery"
                      value={inputs.delivery}
                      onChange={(v) => set("delivery", v as CostInputs["delivery"])}
                      options={[
                        { id: "edge", label: "Edge (LL-HLS via CDN)" },
                        { id: "webrtc", label: "Standard (WebRTC room)" },
                      ]}
                    />
                    {num("busyHoursPerMonth", "Busy hours a month", {
                      suffix: "h",
                      hint: "Every coach's sessions spread over these: sets the peak.",
                    })}
                    {num("boxSessionCapacity", "Sessions a box carries at once", { hint: "Assumed. Beyond it, another box." })}
                    {num("edgeVideoKbps", "Edge video bitrate", { suffix: "kbps" })}
                    {num("edgeAudioKbps", "Edge audio bitrate", { suffix: "kbps" })}
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-3">
                    Peak ≈ {r.servers.peakSessions} sessions and {r.servers.peakEdgeWebinars} edge webinars at once:{" "}
                    {r.servers.boxes || "no"} always-on box{r.servers.boxes === 1 ? "" : "es"}, {r.servers.extraRenderWorkers}{" "}
                    extra render worker{r.servers.extraRenderWorkers === 1 ? "" : "s"} for {count(r.servers.extraRenderHours)} h.
                  </p>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Meetings</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("meetingGbPerParticipantHour", "Camera downlink per participant-hour", {
                      step: 0.1,
                      suffix: "GB",
                      hint: "0.6 GB ≈ 1.3 Mbps with the simulcast ladder.",
                    })}
                    {num("uplinkGbPerPublisherHour", "Uplink per publisher-hour", {
                      step: 0.05,
                      suffix: "GB",
                      hint: "~1.7 Mbps of simulcast layers. Ingress is free; it matters for TURN.",
                    })}
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-3">
                    The same meetings&apos; camera traffic on GCP: {inr(r.meetingsOnGcpUsd)} a coach.
                  </p>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Screen share, TURN and AV1</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("sharePercent", "Share time", { suffix: "% of session", hint: "Someone is sharing." })}
                    {num("shareVideoPercent", "Shares in video mode", { suffix: "%" })}
                    {num("shareH264Percent", "Shares sent as H264", { suffix: "%", hint: "Safari, no VP9." })}
                    {num("shareSlidesVp9Mbps", "Slides, VP9", { step: 0.1, suffix: "Mbps" })}
                    {num("shareSlidesH264Mbps", "Slides, H264", { step: 0.1, suffix: "Mbps" })}
                    {num("shareVideoVp9Mbps", "Video mode, VP9", { step: 0.1, suffix: "Mbps" })}
                    {num("shareVideoH264Mbps", "Video mode, H264", { step: 0.1, suffix: "Mbps" })}
                    {num("edgeShareKbps", "Edge 1080p share profile", {
                      step: 100,
                      suffix: "kbps",
                      hint: "1300 or 1600 (docs/edge-delivery.md). For the share's part of the session.",
                    })}
                    {num("turnPercent", "Relayed through TURN", {
                      suffix: "%",
                      hint: "Counted through the box once more, down and up. TLS is Caddy CPU.",
                    })}
                    {num("av1PublisherPercent", "Publishers on AV1", {
                      suffix: "%",
                      hint: "Desktop Chrome/Edge with 8+ cores.",
                    })}
                    {num("av1ReceiverPercent", "Receivers taking AV1", {
                      suffix: "%",
                      hint: "Not Safari/iOS, weak devices or the recorder: they get the VP8/H264 backup.",
                    })}
                    {num("av1BitrateFactor", "AV1 bitrate factor", { step: 0.05, suffix: "×" })}
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-3">
                    Every subscriber receives the share&apos;s single full layer: {shareMbps(inputs).toFixed(2)} Mbps blended. AV1
                    publishers also send the backup codec (uplink, free) and encode twice on their own CPU.
                  </p>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Simulives</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("hoursPerSimulive", "Hours each", { step: 0.25 })}
                    {num("simuliveWatchPercent", "Average watch", { suffix: "%" })}
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-3">
                    Playback from the public R2 bucket through Cloudflare: no egress, no SFU. Only API traffic and Auto
                    mode answers cost anything.
                  </p>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Recordings</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("recordWebinarsPercent", "Webinars recorded", { suffix: "%" })}
                    {num("recordMeetingsPercent", "Meetings recorded", { suffix: "%" })}
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
                    {num("retentionDays", "Default retention", { suffix: "days" })}
                    {num("keepLongerMonths", "Keep longer adds", { suffix: "months" })}
                    {num("replayHoursPerRecording", "Replay hours per webinar recording", {
                      hint: "All viewers together.",
                    })}
                    {num("recordingGbPerHour", "Composite recorded hour", {
                      step: 0.25,
                      suffix: "GB",
                      hint: "Meetings and standard delivery. Edge records the running mix at its bitrate, with no extra compute.",
                    })}
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-3">
                    The average coach holds {count(r.storage.heldGb)} GB against {r.storage.plan}&apos;s{" "}
                    {count(r.storage.quotaGb)} GB quota{r.storage.overQuota ? " (over it on default retention alone: nothing kept longer)" : ""}.
                    Worst case, every coach full:{" "}
                    {worst.map((w, n) => (
                      <span key={w.plan} className="tabular-nums">
                        {n > 0 && " · "}
                        {w.plan} {count(w.gb)} GB {inr(w.usd)}/coach ({inr(w.platformUsd)} all)
                      </span>
                    ))}
                    .
                  </p>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Captions (box CPU, not cash)</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("liveCaptionCores", "Live captions", { step: 0.5, suffix: "cores" })}
                    {num("finalCaptionFactor", "After-session run length", {
                      step: 0.25,
                      suffix: "× session",
                      hint: "About 0.5–1 × the session.",
                    })}
                    {num("finalCaptionCores", "After-session run", { suffix: "cores" })}
                    {num("captionsModelFactor", "English-only models", {
                      step: 0.05,
                      suffix: "× CPU",
                      hint: "small.en / base.en against the multilingual small the cores were measured on.",
                    })}
                  </div>
                </Card>

                <Card className="p-4">
                  <SectionTitle>AI</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("aiHostMonthlyUsd", "Cap per host (AI_HOST_MONTHLY_USD)", { step: 0.5, suffix: "$" })}
                    {num("qaSkipPercent", "Questions skipped by the confidence gate", {
                      suffix: "%",
                      hint: "No retrieval hit, no model call.",
                    })}
                    {num("draftsPerSession", "Drafts per webinar")}
                    {num("autoAnswersPerSimulive", "Auto answers per simulive")}
                    {num("leadsPerWebinar", "Hot leads per webinar", { hint: "Each gets a follow-up written." })}
                    {num("libraryWordsPerMonth", "New library words a month", { hint: "Embedded once." })}
                  </div>
                  <div className="mt-3">
                    <Disclosure summary="Token estimates and prices">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {num("aiInPerM", "gpt-5-nano input", { step: 0.01, suffix: "$/M" })}
                        {num("aiOutPerM", "gpt-5-nano output", { step: 0.01, suffix: "$/M" })}
                        {num("embedPerM", "text-embedding-3-small", { step: 0.01, suffix: "$/M" })}
                        {num("tokensPerQuestion", "Tokens per question")}
                        {num("recapInKPerHour", "Recap in, per session-hour", { suffix: "k" })}
                        {num("recapOutKPerHour", "Recap out, per session-hour", { suffix: "k" })}
                        {num("qaInK", "Q&A grouping in", { suffix: "k" })}
                        {num("qaOutK", "Q&A grouping out", { suffix: "k" })}
                        {num("draftInK", "Draft or answer in", { step: 0.1, suffix: "k" })}
                        {num("draftOutK", "Draft or answer out", { step: 0.1, suffix: "k" })}
                        {num("leadsInK", "Hot leads in", { suffix: "k" })}
                        {num("leadsOutK", "Hot leads out", { suffix: "k" })}
                        {num("followupInK", "Follow-up in, per lead", { step: 0.1, suffix: "k" })}
                        {num("followupOutK", "Follow-up out, per lead", { step: 0.1, suffix: "k" })}
                        {num("harvestInK", "Answer harvest in", { suffix: "k" })}
                        {num("harvestOutK", "Answer harvest out", { suffix: "k" })}
                      </div>
                    </Disclosure>
                  </div>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Messaging</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("emailsPerMeetingParticipant", "Emails per meeting participant")}
                    {num("emailUsd", "Cost per email", { step: 0.0001, suffix: "$" })}
                    {num("waMarketingPerRegistrant", "WhatsApp marketing per registrant")}
                    {num("waUtilityPerRegistrant", "WhatsApp utility per registrant")}
                    {num("waMarketingInr", "WhatsApp marketing", { step: 0.01, suffix: "₹" })}
                    {num("waUtilityInr", "WhatsApp utility", { step: 0.01, suffix: "₹" })}
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-3">
                    WhatsApp is billed to the coach&apos;s WABA, not us: shown, never added. Push replaces reminders only
                    (every registrant email but the confirmation); browser push services are free.
                  </p>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Fixed and shared</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("supabaseUsd", "Supabase plan", { suffix: "$/mo" })}
                    {num("cloudRunUsd", "Cloud Run compute (estimate)", {
                      suffix: "$/mo",
                      hint: "Only when the API is on Cloud Run.",
                    })}
                    {num("workersUsd", "Cloudflare Workers", { suffix: "$/mo" })}
                    {num("bunnyMinUsd", "Bunny monthly minimum", { suffix: "$" })}
                  </div>
                </Card>

                <Card className="p-4">
                  <SectionTitle>{name} rates</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {rateNum("boxMonthlyUsd", "Always-on SFU box", {
                      suffix: "$/mo",
                      hint: "0 when the SFU starts per session.",
                    })}
                    {rateNum("boxIncludedTb", "Box transfer included", { suffix: "TB" })}
                    {rateNum("boxCores", "Box cores")}
                    {rateNum("sfuPerHour", "Per-session SFU", { step: 0.01, suffix: "$/h" })}
                    {rateNum("workerPerHour", "Render/egress worker", { step: 0.005, suffix: "$/h" })}
                    {rateNum("workerIncludedTb", "Worker transfer, prorated", { suffix: "TB/mo" })}
                    {rateNum("overagePerGb", "Transfer beyond the pool", { step: 0.001, suffix: "$/GB" })}
                    <SelectField
                      label="API host"
                      value={rates.apiHost}
                      onChange={(v) => setRate("apiHost", v as ProviderRates["apiHost"])}
                      options={[
                        { id: "cloudrun", label: "Cloud Run" },
                        { id: "server", label: inputs.provider === "do" ? "A droplet" : "A server" },
                      ]}
                    />
                    {rates.apiHost === "server" && (
                      <>
                        {rateNum("apiServerMonthlyUsd", "API server", { suffix: "$/mo" })}
                        {rateNum("apiServerIncludedTb", "API server transfer", { suffix: "TB" })}
                      </>
                    )}
                  </div>
                  <div className="mt-3 grid gap-1">
                    <Toggle
                      checked={rates.workerColocated}
                      onChange={(v) => setRate("workerColocated", v)}
                      label="First edge render runs on the box"
                    />
                    <Toggle
                      checked={rates.compositeOnBox}
                      onChange={(v) => setRate("compositeOnBox", v)}
                      label="Composite recordings run on the box"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setInputs((prev) => ({
                        ...prev,
                        providers: { ...prev.providers, [prev.provider]: DEFAULT_INPUTS.providers[prev.provider] },
                      }))
                    }
                    className="mt-3 text-[12.5px] font-medium text-brand hover:underline"
                  >
                    Reset {name} rates
                  </button>
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
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {num("targetMarginPercent", "Target gross margin", { suffix: "%" })}
                    {num("overheadInr", "Support and overhead", { suffix: "₹/mo", hint: "Per coach." })}
                    <SelectField
                      label="Plan attendee cap"
                      value={String(inputs.planAttendeeCap)}
                      onChange={(v) => set("planAttendeeCap", Number(v))}
                      options={PLAN_CAPS.map((c) => ({ id: String(c), label: `${c} attendees` }))}
                    />
                  </div>
                </Card>

                <Card className="p-4">
                  <SectionTitle>Other prices and rates</SectionTitle>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {num("inrPerUsd", "Rupees per dollar")}
                    {num("cdnPerGb", "CDN per GB", { step: 0.001, suffix: "$" })}
                    {num("cloudRunEgressPerGb", "Cloud Run egress per GB", { step: 0.01, suffix: "$" })}
                    {num("originPulls", "CDN locations pulling the origin")}
                    {num("warmupMinutes", "Warm-up per session", { suffix: "min" })}
                    {num("webrtcViewerMbps", "WebRTC viewer", { step: 0.1, suffix: "Mbps" })}
                    {num("apiMbPerViewerHour", "API traffic per attendee-hour", { step: 0.5, suffix: "MB" })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setInputs(DEFAULT_INPUTS)}
                    className="mt-3 text-[12.5px] font-medium text-brand hover:underline"
                  >
                    Reset everything to defaults
                  </button>
                </Card>
              </div>

              <div className="grid content-start gap-5">
                <div className="grid grid-cols-2 gap-3">
                  <Stat
                    label="Per attendee-hour"
                    value={fine(r.perViewerHourUsd)}
                    note={`Delivery · ${count(r.viewerHours)} attendee-hours`}
                  />
                  <Stat
                    label="Per participant-hour"
                    value={fine(r.perParticipantHourUsd)}
                    note={`Meetings · ${count(r.participantHours)} participant-hours`}
                  />
                  <Stat
                    label="Per recorded hour"
                    value={fine(r.perRecordedHourUsd)}
                    note={`${r.recordedHours.toFixed(1)} hours recorded`}
                  />
                  <Stat
                    label="AI per session"
                    value={fine(r.aiPerSessionUsd)}
                    note={
                      r.aiCapped
                        ? `Capped at $${inputs.aiHostMonthlyUsd} (wanted ${usd(r.aiUncappedUsd)})`
                        : `${usd(r.aiUncappedUsd)} a month, under the cap`
                    }
                    tone={r.aiCapped ? "warn" : "neutral"}
                  />
                  <Stat
                    label="Transfer pool"
                    value={r.pool.percent == null ? "None" : `${Math.round(r.pool.percent)}%`}
                    note={r.pool.overageGb > 0 ? `${count(r.pool.overageGb)} GB billed` : "Nothing beyond the pool"}
                    tone={r.pool.percent != null && r.pool.percent > 90 ? "warn" : "neutral"}
                  />
                  <Stat
                    label="Margin (before overhead)"
                    value={r.marginPercent == null ? "—" : `${Math.round(r.marginPercent)}%`}
                    note={
                      r.marginUsd == null || r.netRevenueUsd == null
                        ? "Enter a plan price"
                        : `${inr(r.marginUsd)} of ${inr(r.netRevenueUsd)} net`
                    }
                  />
                </div>

                <Card className="p-4">
                  <SectionTitle>Minimum price ({name})</SectionTitle>
                  <p className="text-[12.5px] text-ink-2">
                    Cost ₹{count(pricing.costInr)} a coach incl. overhead; break-even ₹{count(pricing.breakEvenInr)}, minimum at{" "}
                    {inputs.targetMarginPercent}% ₹{count(pricing.minimumInr)} (rounded up to a ₹99 ending). It includes
                    every feature switched on above, the new ones too (screen share {inr(r.deltas.shareUsd)}, TURN{" "}
                    {inr(r.deltas.turnUsd)}, AV1 {inr(r.deltas.av1Usd)}, 1080p share profile {inr(r.deltas.edgeShareUsd)}, push{" "}
                    {inr(r.deltas.pushUsd)}, YouTube {inr(r.deltas.youtubeUsd)} a coach).
                  </p>
                  <p className="mt-1 text-[12.5px] text-ink-2">
                    Break-even by scale:{" "}
                    {pricing.breakEvenAt.map((b, n) => (
                      <span key={b.coaches} className="tabular-nums">
                        {n > 0 && " · "}
                        {b.coaches} {b.coaches === 1 ? "coach" : "coaches"} ₹{count(b.inr)}
                      </span>
                    ))}
                  </p>
                  {pricing.overage && (
                    <p className="mt-1 text-[12.5px] text-warn">
                      {inputs.viewersPerWebinar} attendees is over the {inputs.planAttendeeCap} cap:{" "}
                      {count(pricing.overage.attendeeHours)} extra attendee-hours a month. Overage at the same margin: ₹
                      {pricing.overage.perAttendeeHourInr.toFixed(2)} per attendee-hour (≈ ₹{count(pricing.overage.monthInr)} a
                      month).
                    </p>
                  )}
                </Card>

                <Card className="overflow-hidden">
                  <table className="w-full text-left text-[13px]">
                    <thead className="border-b border-line bg-surface-2 text-[11.5px] text-ink-3">
                      <tr>
                        <th className="px-4 py-2 font-medium">Every line, per coach</th>
                        <th className="px-4 py-2 text-right font-medium">A month</th>
                        <th className="px-4 py-2 text-right font-medium">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {GROUP_ORDER.map((g) => {
                        const lines = r.lines.filter((l) => l.group === g);
                        if (lines.length === 0) return null;
                        const billed = g !== "info";
                        return (
                          <Fragment key={g}>
                            <tr className="border-b border-line bg-surface-2">
                              <td className="px-4 py-1.5 text-[11.5px] font-semibold text-ink-2">{GROUP_LABELS[g]}</td>
                              <td className="px-4 py-1.5 text-right text-[11.5px] font-semibold tabular-nums text-ink-2">
                                {billed ? inr(r.groups[g]) : ""}
                              </td>
                              <td className="px-4 py-1.5 text-right text-[11.5px] tabular-nums text-ink-3">
                                {billed && r.monthUsd > 0 ? `${Math.round((r.groups[g] / r.monthUsd) * 100)}%` : ""}
                              </td>
                            </tr>
                            {lines.map((l) => (
                              <tr key={l.key} className="border-b border-line last:border-0">
                                <td className="px-4 py-2.5">
                                  <div className={`font-medium ${l.info ? "text-ink-2" : "text-ink"}`}>{l.label}</div>
                                  <div className="text-[11.5px] text-ink-3">{l.note}</div>
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                                  {l.info ? (
                                    <span className="text-ink-3">$0 to us</span>
                                  ) : (
                                    <>
                                      {inr(l.usd)}
                                      <div className="text-[11.5px] text-ink-3">{usd(l.usd)}</div>
                                    </>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">
                                  {!l.info && r.monthUsd > 0 ? `${Math.round((l.usd / r.monthUsd) * 100)}%` : "—"}
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })}
                      {r.monthUsd === 0 && (
                        <tr>
                          <td colSpan={3} className="px-4 py-6 text-center text-ink-3">
                            Nothing to bill yet. Enter some usage.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </Card>
              </div>
            </div>
          </div>
        </Disclosure>
      </Card>

      <p className="text-[12px] leading-relaxed text-ink-3">
        Estimates at list prices. Usage is the average coach; fixed costs and the transfer pool are the
        platform&apos;s, shared over {r.coaches} coaches. Some provider prices and the new features&apos; shares are
        assumed (listed at the top of lib/cost-calculator.ts) — check them before quoting.
      </p>
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

/** A small number with its unit after it, for the feature table's usage column. */
function MiniField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        aria-label={label}
        className="field w-[4.5rem] py-1 text-[12.5px] tabular-nums"
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      />
      {label}
    </label>
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
