"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  calculateCost,
  calculatePricing,
  compareProviders,
  DEFAULT_INPUTS,
  GROUP_LABELS,
  PLAN_CAPS,
  PRESETS,
  PROVIDERS,
  RECORDING_STORES,
  withDefaults,
  type CostGroup,
  type CostInputs,
  type Preset,
  type Provider,
  type ProviderRates,
  type RecordingStore,
} from "@/lib/cost-calculator";
import { Disclosure, Toggle } from "./controls";
import { Card, SectionTitle, Stat } from "./ui";

/* The admin Cost calculator: what the platform costs us a month and one coach's share, from
 * how coaches run webinars, meetings and simulives.
 *
 * The arithmetic is lib/cost-calculator.ts; this is its inputs and a breakdown. Prices are
 * inputs too, so a new quote can be tried without a deploy, and every provider's rates are
 * kept separately so the switch at the top swaps them all at once. Inputs persist in this
 * browser only — it is a scratchpad, not a setting. */

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
  const setRate = <K extends keyof ProviderRates>(key: K, value: ProviderRates[K]) =>
    setInputs((prev) => ({
      ...prev,
      providers: { ...prev.providers, [prev.provider]: { ...prev.providers[prev.provider], [key]: value } },
    }));
  const r = useMemo(() => calculateCost(inputs), [inputs]);
  const compare = useMemo(() => compareProviders(inputs), [inputs]);
  const pricing = useMemo(() => calculatePricing(inputs), [inputs]);
  const rates = inputs.providers[inputs.provider];
  const rate = inputs.inrPerUsd > 0 ? inputs.inrPerUsd : 1;
  const inr = (usd: number) =>
    `₹${(usd * rate).toLocaleString("en-IN", { maximumFractionDigits: usd * rate < 10 ? 2 : 0 })}`;
  const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
  const fine = (n: number) => `₹${(n * rate).toFixed(2)}`;
  const count = (n: number) => Math.round(n).toLocaleString("en-IN");

  const num = (key: keyof CostInputs, label: string, opts: NumOpts = {}) => (
    <NumberField label={label} value={inputs[key] as number} onChange={(v) => set(key, v as never)} {...opts} />
  );
  const rateNum = (key: keyof ProviderRates, label: string, opts: NumOpts = {}) => (
    <NumberField label={label} value={rates[key] as number} onChange={(v) => setRate(key, v as never)} {...opts} />
  );
  const name = PROVIDER_NAMES[inputs.provider];

  return (
    <div className="grid gap-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Video provider</SectionTitle>
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
        <p className="text-[11.5px] text-ink-3">
          Switching swaps the SFU box, workers, included transfer and overage, and the API host.
          The same inputs on each:
        </p>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-left text-[12.5px]">
            <thead className="text-[11.5px] text-ink-3">
              <tr>
                <th className="py-1 font-medium">Provider</th>
                <th className="py-1 text-right font-medium">Per coach</th>
                <th className="py-1 text-right font-medium">Platform</th>
                <th className="py-1 text-right font-medium">Attendee-hour</th>
                <th className="py-1 text-right font-medium">Participant-hour</th>
                <th className="py-1 text-right font-medium">Pool used</th>
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
                    <td className="py-1.5 text-right tabular-nums">{fine(c.perViewerHourUsd)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fine(c.perParticipantHourUsd)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {c.pool.percent == null ? "no pool" : `${Math.round(c.pool.percent)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="grid content-start gap-5">
          <Card className="p-4">
            <SectionTitle>Coach presets</SectionTitle>
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
            <p className="mt-2 text-[11.5px] text-ink-3">
              Light: 4 webinars × 1 h × 100, 10 meetings × 5. Typical: 8 × 1.5 h × 300, 25 × 10. Heavy: 12 ×
              2 h × 500, 40 × 15. Sets the usage only.
            </p>
          </Card>

          <Card className="p-4">
            <SectionTitle>Webinars per coach</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {num("webinarsPerMonth", "Webinars a month")}
              {num("hoursPerWebinar", "Hours per webinar", { step: 0.25 })}
              {num("viewersPerWebinar", "Attendees per webinar")}
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
              {inputs.delivery === "edge" && (
                <>
                  {num("peakConcurrentEdge", "Peak concurrent edge webinars", {
                    hint: "All coaches. Each beyond the first needs a render worker.",
                  })}
                  {num("extraRenderHoursEach", "Hours each extra worker runs", { suffix: "h/mo" })}
                  {num("edgeVideoKbps", "Edge video bitrate", { suffix: "kbps" })}
                  {num("edgeAudioKbps", "Edge audio bitrate", { suffix: "kbps" })}
                </>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <SectionTitle>Meetings per coach</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {num("meetingsPerMonth", "Meetings a month")}
              {num("participantsPerMeeting", "Participants per meeting")}
              {num("hoursPerMeeting", "Hours per meeting", { step: 0.25 })}
              {num("meetingGbPerParticipantHour", "Downlink per participant-hour", {
                step: 0.1,
                suffix: "GB",
                hint: "0.6 GB ≈ 1.3 Mbps with the simulcast ladder.",
              })}
            </div>
            <p className="mt-2 text-[11.5px] text-ink-3">
              {r.pool.percent == null
                ? `No transfer pool on ${name}: every GB bills.`
                : `Transfer pool ${Math.round(r.pool.percent)}% used (${count(r.pool.usedGb)} of ${count(r.pool.includedGb)} GB, all coaches).`}{" "}
              The same meetings&apos; traffic on GCP: {inr(r.meetingsOnGcpUsd)} a coach.
            </p>
          </Card>

          <Card className="p-4">
            <SectionTitle>Simulives per coach</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {num("simulivesPerMonth", "Simulives a month")}
              {num("hoursPerSimulive", "Hours each", { step: 0.25 })}
              {num("viewersPerSimulive", "Viewers each")}
              {num("simuliveWatchPercent", "Average watch", { suffix: "%" })}
            </div>
            <p className="mt-2 text-[11.5px] text-ink-3">
              Assumes playback from the public R2 bucket through Cloudflare (the recordings domain): no
              egress, no SFU. Only API traffic and Auto mode answers cost anything.
            </p>
          </Card>

          <Card className="p-4">
            <SectionTitle>Recordings</SectionTitle>
            <Toggle checked={inputs.recording} onChange={(v) => set("recording", v)} label="Record sessions" />
            {inputs.recording && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
                {num("recordingMonths", "Kept for", { suffix: "months" })}
                {num("replayHoursPerRecording", "Replay hours per webinar recording", {
                  hint: "All viewers together.",
                })}
                {num("recordingGbPerHour", "Composite recorded hour", {
                  step: 0.25,
                  suffix: "GB",
                  hint: "Meetings and standard delivery. Edge records the running mix at its bitrate, with no extra compute.",
                })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <SectionTitle>Captions (box CPU, not cash)</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {num("captionsPercent", "Sessions with captions on", { suffix: "%" })}
              {num("liveCaptionCores", "Live captions", { step: 0.5, suffix: "cores" })}
              {num("finalCaptionFactor", "After-session run length", {
                step: 0.25,
                suffix: "× session",
                hint: "About 0.5–1 × the session.",
              })}
              {num("finalCaptionCores", "After-session run", { suffix: "cores" })}
            </div>
          </Card>

          <Card className="p-4">
            <SectionTitle>AI</SectionTitle>
            <Toggle checked={inputs.ai} onChange={(v) => set("ai", v)} label="AI features on" />
            {inputs.ai && (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {num("aiHostMonthlyUsd", "Cap per host (AI_HOST_MONTHLY_USD)", { step: 0.5, suffix: "$" })}
                  {num("draftsPerSession", "Drafts per webinar")}
                  {num("autoAnswersPerSimulive", "Auto answers per simulive")}
                  {num("leadsPerWebinar", "Hot leads per webinar", { hint: "Each gets a follow-up written." })}
                  {num("libraryWordsPerMonth", "New library words a month", { hint: "Embedded once." })}
                  {num("questionsPerSession", "Questions per session")}
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
              </>
            )}
          </Card>

          <Card className="p-4">
            <SectionTitle>Messaging</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {num("emailsPerRegistrant", "Emails per registrant")}
              {num("emailsPerMeetingParticipant", "Emails per meeting participant")}
              {num("emailUsd", "Cost per email", { step: 0.0001, suffix: "$" })}
              {num("waMarketingPerRegistrant", "WhatsApp marketing per registrant")}
              {num("waUtilityPerRegistrant", "WhatsApp utility per registrant")}
              {num("waMarketingInr", "WhatsApp marketing", { step: 0.01, suffix: "₹" })}
              {num("waUtilityInr", "WhatsApp utility", { step: 0.01, suffix: "₹" })}
            </div>
            <p className="mt-2 text-[11.5px] text-ink-3">
              WhatsApp is billed to the coach&apos;s WABA, not us: shown, never added.
            </p>
          </Card>

          <Card className="p-4">
            <SectionTitle>Fixed and shared</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {num("coaches", "Spread over coaches", { hint: "Fixed costs and the transfer pool are shared." })}
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
            <Disclosure summary="Other prices and rates">
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
            </Disclosure>
          </Card>
        </div>

        <div className="grid content-start gap-5 lg:sticky lg:top-4">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Per coach a month" value={inr(r.monthUsd)} note={usd(r.monthUsd)} tone="brand" />
            <Stat
              label="Platform a month"
              value={inr(r.platformMonthUsd)}
              note={`${r.coaches} coaches · ${usd(r.platformMonthUsd)}`}
            />
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
              label="Margin"
              value={r.marginPercent == null ? "—" : `${Math.round(r.marginPercent)}%`}
              note={
                r.marginUsd == null || r.netRevenueUsd == null
                  ? "Enter a plan price"
                  : `${inr(r.marginUsd)} of ${inr(r.netRevenueUsd)} net`
              }
              tone={
                r.marginPercent == null ? "neutral" : r.marginPercent < 30 ? "live" : r.marginPercent < 50 ? "warn" : "ok"
              }
            />
          </div>

          <Card className="p-4">
            <SectionTitle>Minimum price ({name})</SectionTitle>
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Break-even price"
                value={`₹${count(pricing.breakEvenInr)}`}
                note={`Cost ₹${count(pricing.costInr)} incl. overhead, grossed up for fee${inputs.priceIncludesGst ? " and GST" : ""}`}
              />
              <Stat
                label={`Minimum at ${inputs.targetMarginPercent}% margin`}
                value={`₹${count(pricing.minimumInr)}`}
                note="Rounded up to a ₹99 ending"
                tone="brand"
              />
            </div>
            <p className="mt-3 text-[12.5px] text-ink-2">
              {pricing.currentMarginPercent == null
                ? "Enter a plan price to see its margin."
                : `At ₹${count(inputs.priceInr)}: ${Math.round(pricing.currentMarginPercent)}% margin (₹${count(pricing.currentMarginInr!)} a month, overhead included).`}
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
                  <th className="px-4 py-2 font-medium">What, per coach</th>
                  <th className="px-4 py-2 text-right font-medium">A month</th>
                  <th className="px-4 py-2 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {GROUP_ORDER.map((g) => {
                  const rows = r.lines.filter((l) => l.group === g);
                  if (rows.length === 0) return null;
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
                      {rows.map((l) => (
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

          <p className="text-[12px] leading-relaxed text-ink-3">
            Estimates at list prices. Usage is the average coach; fixed costs and the transfer pool are
            the platform&apos;s, shared over {r.coaches} coaches. Some provider prices are assumed (listed
            at the top of lib/cost-calculator.ts) — check them before quoting.
          </p>
        </div>
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
