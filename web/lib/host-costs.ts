/* The admin "Cost by host" report's arithmetic: recorded usage (GET /api/admin/costs, see
 * api/types/costs.go) priced at the Cost calculator's rates (lib/cost-calculator.ts), so a
 * price is changed in one place. ESTIMATES: what the usage would cost at those rates, not
 * what any invoice says. Only AI is exact (ai_usage records each call's cost).
 *
 * Allocation rules:
 *   - Transfer pools (DigitalOcean, Hetzner): the platform's GB on a provider in the range
 *     against the pool it brought (the box for the range, workers prorated by their hours, the
 *     API server when it is there); the overage is spread back over every GB, so a host pays
 *     their GB × the pool's effective $/GB. GCP has no pool, so that is its egress price.
 *   - Video server: each session's concurrency-split hours (the API splits an hour two
 *     sessions share) × the box's hourly cost, or GCP's per-session SFU rate. The box's idle
 *     hours are platform cost.
 *   - Render workers: on a box that renders one mix itself, only the Edge webinars live at
 *     once beyond the first need workers (their time is split among them); on GCP every Edge
 *     webinar needs one.
 *   - Platform (Supabase, Workers, the API host, the boxes' idle time, AI and storage with
 *     no host): either spread by each host's share of session-hours, or left as one
 *     "unallocated" figure.
 *   - Ignore list (test and staff accounts, api/internal/api/cost_ignore.go): hidden, those
 *     hosts leave the totals and the share is spread over the other hosts' session-hours.
 *
 * Pure: no React, no DOM, so it runs under node tests. */

import type {
  AdminCostHost,
  AdminCostPlatform,
  AdminCostSession,
  AdminCostUsage,
} from "./api-types.ts";
import { GB_PER_MBPS_HOUR, stageMbps } from "./admin-costs.ts";
import {
  edgeGbPerViewerHour,
  edgeVideoKbps,
  PROVIDERS,
  RECORDING_STORES,
  sfuAdjust,
  type CostInputs,
  type Provider,
} from "./cost-calculator.ts";

const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;

export type CostColumn = "delivery" | "meetings" | "video" | "recording" | "ai" | "email" | "platform";

export const COST_COLUMNS: CostColumn[] = ["delivery", "meetings", "video", "recording", "ai", "email", "platform"];

export const COLUMN_LABELS: Record<CostColumn, string> = {
  delivery: "Delivery",
  meetings: "Meetings",
  video: "Video server",
  recording: "Recording & storage",
  ai: "AI",
  email: "Email",
  platform: "Platform share",
};

export type HostCostLine = {
  key: string;
  column: CostColumn;
  label: string;
  usd: number;
  note: string;
  /** Shown for context, costs us nothing. */
  info?: boolean;
};

export type PoolRate = {
  usedGb: number;
  includedGb: number;
  overageGb: number;
  /** What one GB through this provider costs, the pool shared out. */
  perGb: number;
};

const nn = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
const fmt = (n: number, digits = 1) => n.toLocaleString("en-IN", { maximumFractionDigits: digits });
const hoursBetween = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3.6e6);

export function isProvider(p: string): p is Provider {
  return (PROVIDERS as string[]).includes(p);
}

/** The GB a usage moves out of the video server, by what for. */
export function usageGb(u: AdminCostUsage, i: CostInputs) {
  // The 1080p share profile, when on, raises the mix's average bitrate (edgeVideoKbps).
  const perViewerHour = edgeGbPerViewerHour(edgeVideoKbps(i), nn(i.edgeAudioKbps));
  // Stage traffic is linear in the pairs: stageMbps(2) is one pair each way.
  const [lo, hi] = stageMbps(2);
  const perPairMbps = (lo + hi) / 2 / 2;
  const cdn = nn(u.edgeViewerHours) * perViewerHour;
  const origin = nn(u.edgeLiveHours) * nn(i.originPulls) * perViewerHour;
  const webrtc = nn(u.webrtcViewerHours) * nn(i.webrtcViewerMbps) * GB_PER_MBPS_HOUR;
  const stage = nn(u.stagePairHours) * perPairMbps * GB_PER_MBPS_HOUR;
  const meeting = nn(u.meetingParticipantHours) * nn(i.meetingGbPerParticipantHour);
  const upload = nn(u.recordedGb);
  // Screen share, AV1 and TURN at the calculator's assumptions (lib/cost-calculator.ts
  // sfuAdjust). Meetings: every participant publishes and receives shares. Webinars: WebRTC
  // viewers receive shares; the stage's publishers and share receivers are not in the usage.
  const m = sfuAdjust(i, { camGb: meeting, shareReceiverHours: nn(u.meetingParticipantHours), publisherHours: nn(u.meetingParticipantHours) });
  const w = sfuAdjust(i, { camGb: webrtc + stage, shareReceiverHours: nn(u.webrtcViewerHours), publisherHours: 0 });
  const share = m.shareGb + w.shareGb;
  const turn = m.turnGb + w.turnGb;
  const av1 = m.av1Gb + w.av1Gb;
  return {
    perViewerHour, cdn, origin, webrtc, stage, meeting, upload, share, turn, av1,
    pooled: Math.max(0, origin + webrtc + stage + meeting + upload + share + turn + av1),
  };
}

/** Worker hours a usage needs on a provider: Edge renders and composite recordings. */
export function workerHours(u: AdminCostUsage, p: Provider, i: CostInputs) {
  const r = i.providers[p];
  const render = r.workerColocated ? nn(u.edgeExtraHours) : nn(u.edgeLiveHours);
  const composite = r.compositeOnBox ? 0 : nn(u.compositeRecHours);
  return { render, composite };
}

/** Hours of the range a provider's box existed. A box created on demand (the API's
 *  platform.boxHours, from its droplets' lifetimes) counts what it actually ran; any other
 *  runs around the clock from its first session (or the range's start). */
export function boxHours(p: Provider, platform: AdminCostPlatform, rangeStart: string, rangeEnd: string): number {
  const measured = platform.boxHours?.[p];
  if (typeof measured === "number") return Math.max(0, measured);
  const first = platform.firstSessionAt?.[p];
  if (!first) return 0;
  const start = Date.parse(first) > Date.parse(rangeStart) ? first : rangeStart;
  return hoursBetween(start, rangeEnd);
}

/** Each provider's pool over the range, from the whole platform's usage. */
export function poolRates(
  platform: AdminCostPlatform,
  rangeStart: string,
  rangeEnd: string,
  i: CostInputs,
): Record<Provider, PoolRate> {
  const out = {} as Record<Provider, PoolRate>;
  const rangeHours = hoursBetween(rangeStart, rangeEnd);
  for (const p of PROVIDERS) {
    const r = i.providers[p];
    const u = platform.byProvider?.[p];
    const usedGb = u ? usageGb(u, i).pooled : 0;
    const w = u ? workerHours(u, p, i) : { render: 0, composite: 0 };
    const apiTb = p === i.provider && r.apiHost === "server" ? nn(r.apiServerIncludedTb) * (rangeHours / HOURS_PER_MONTH) : 0;
    const includedGb =
      (nn(r.boxIncludedTb) * (boxHours(p, platform, rangeStart, rangeEnd) / HOURS_PER_MONTH) +
        (nn(r.workerIncludedTb) * (w.render + w.composite)) / HOURS_PER_MONTH +
        apiTb) *
      1000;
    const overageGb = Math.max(0, usedGb - includedGb);
    const perGb = usedGb > 0 ? (overageGb * nn(r.overagePerGb)) / usedGb : includedGb > 0 ? 0 : nn(r.overagePerGb);
    out[p] = { usedGb, includedGb, overageGb, perGb };
  }
  return out;
}

/** The session-priced lines of one usage on one provider ("none": no video server of ours). */
export function priceUsage(
  u: AdminCostUsage,
  provider: string,
  i: CostInputs,
  pools: Record<Provider, PoolRate>,
): HostCostLine[] {
  const lines: HostCostLine[] = [];
  const add = (column: CostColumn, key: string, label: string, usd: number, note: string) => {
    if (usd > 0) lines.push({ key, column, label, usd, note });
  };
  const info = (column: CostColumn, key: string, label: string, note: string) =>
    lines.push({ key, column, label, usd: 0, note, info: true });

  if (nn(u.simuliveViewerHours) > 0) {
    info("delivery", "simulive", "Simulive playback", `${fmt(u.simuliveViewerHours)} viewer-hours from R2: $0 egress, API traffic only`);
  }
  if (nn(u.zoomAttendeeHours) > 0) {
    info("delivery", "zoom", "Zoom venue", `${fmt(u.zoomAttendeeHours)} attendee-hours on the host's Zoom account`);
  }
  if (!isProvider(provider)) return lines;

  const r = i.providers[provider];
  const pool = pools[provider];
  const gb = usageGb(u, i);
  const w = workerHours(u, provider, i);
  const poolNote = pool.includedGb > 0 ? `pool rate $${pool.perGb.toFixed(4)}/GB` : `$${pool.perGb.toFixed(3)}/GB`;

  // Delivery: Edge (CDN, origin pulls, render workers) and WebRTC (SFU egress), plus the stage.
  add("delivery", "cdn", "Edge: CDN", gb.cdn * nn(i.cdnPerGb),
    `${fmt(u.edgeViewerHours)} viewer-hours × ${gb.perViewerHour.toFixed(2)} GB × $${nn(i.cdnPerGb)}/GB`);
  add("delivery", "origin", "Edge: origin → CDN", gb.origin * pool.perGb,
    `${fmt(gb.origin)} GB (${nn(i.originPulls)} pulls of ${fmt(u.edgeLiveHours)} live hours), ${poolNote}`);
  add("delivery", "render", "Edge: render workers", w.render * nn(r.workerPerHour),
    r.workerColocated
      ? `${fmt(w.render, 2)} h beyond the first Edge webinar live at once × $${nn(r.workerPerHour)}/h`
      : `${fmt(w.render, 2)} h, one per Edge webinar × $${nn(r.workerPerHour)}/h`);
  add("delivery", "webrtc", "WebRTC viewers (SFU egress)", gb.webrtc * pool.perGb,
    `${fmt(u.webrtcViewerHours)} viewer-hours × ${nn(i.webrtcViewerMbps)} Mbps = ${fmt(gb.webrtc)} GB, ${poolNote}`);
  add("delivery", "stage", "Stage traffic", gb.stage * pool.perGb, `${fmt(gb.stage)} GB, ${poolNote}`);
  // Screen share, TURN and AV1 (a saving), at the calculator's assumptions.
  add("delivery", "share", "Screen share (SFU)", gb.share * pool.perGb, `${fmt(gb.share)} GB, ${poolNote}`);
  add("delivery", "turn", "TURN relay", gb.turn * pool.perGb, `${fmt(gb.turn)} GB relayed once more, ${poolNote}`);
  if (gb.av1 * pool.perGb < 0) {
    lines.push({ key: "av1", column: "delivery", label: "AV1 saving", usd: gb.av1 * pool.perGb, note: `${fmt(-gb.av1)} GB less camera downlink, ${poolNote}` });
  }
  if ((gb.origin + gb.webrtc + gb.stage) > 0 && pool.perGb === 0) {
    info("delivery", "in-pool", "Video server transfer", `${fmt(gb.origin + gb.webrtc + gb.stage)} GB, within the pool`);
  }

  // Meetings: participants' downlink.
  if (gb.meeting > 0 && gb.meeting * pool.perGb === 0) {
    info("meetings", "meeting-transfer", "Meeting transfer", `${fmt(gb.meeting)} GB within the pool`);
  }
  add("meetings", "meeting-transfer", "Meeting transfer (SFU downlink)", gb.meeting * pool.perGb,
    `${fmt(u.meetingParticipantHours)} participant-hours × ${nn(i.meetingGbPerParticipantHour)} GB, ${poolNote}`);

  // Video server: the box's hour, or GCP's per-session SFU, split by concurrency.
  const hourly = nn(r.boxMonthlyUsd) / HOURS_PER_MONTH + nn(r.sfuPerHour);
  add("video", "server", `Video server (${r.label})`, nn(u.boxShareHours) * hourly,
    `${fmt(u.boxShareHours, 2)} h of ${fmt(u.liveHours, 2)} live (shared hours split) × $${hourly.toFixed(3)}/h`);

  // Recording.
  add("recording", "composite", "Composite recording workers", w.composite * nn(r.workerPerHour),
    `${fmt(w.composite, 2)} h × $${nn(r.workerPerHour)}/h`);
  if (nn(u.compositeRecHours) > 0 && w.composite === 0) {
    info("recording", "composite-box", "Composite recording", `${fmt(u.compositeRecHours, 2)} h on the box`);
  }
  if (nn(u.mixRecHours) + nn(u.browserRecHours) > 0) {
    info("recording", "mix", "Mix and browser recordings",
      `${fmt(nn(u.mixRecHours) + nn(u.browserRecHours), 2)} h: no extra encode`);
  }
  add("recording", "upload", "Recording upload", gb.upload * pool.perGb, `${fmt(gb.upload, 2)} GB, ${poolNote}`);

  // Captions: CPU on the box, already paid for in the video server line.
  let coreHours =
    nn(u.captionLiveHours) * nn(i.liveCaptionCores) +
    nn(u.captionFinalHours) * nn(i.finalCaptionFactor) * nn(i.finalCaptionCores);
  // English-only models (small.en / base.en) run at ~captionsModelFactor of the measured cores.
  coreHours *= nn(i.captionsModelFactor) || 1;
  if (coreHours > 0) {
    info("video", "captions", "Captions", `${fmt(coreHours)} box CPU-hours: $0, the box's time is in Video server`);
  }
  return lines;
}

/** The lines of a host that belong to no session: AI, mail, storage. */
export function priceExtras(h: AdminCostHost, i: CostInputs): HostCostLine[] {
  const lines: HostCostLine[] = [];
  const x = h.extras;
  const store = RECORDING_STORES[i.recordingStore] ?? RECORDING_STORES.r2;
  const perGbDay = store.perGbMonth / DAYS_PER_MONTH;
  for (const a of x.ai ?? []) {
    if (a.costUsd > 0 || a.calls > 0) {
      lines.push({
        key: `ai-${a.feature}`,
        column: "ai",
        label: `AI: ${a.feature.replaceAll("_", " ")}`,
        usd: a.costUsd,
        note: `${fmt(a.calls, 0)} calls, ${fmt(a.promptTokens / 1000)}k in / ${fmt(a.completionTokens / 1000)}k out (exact)`,
      });
    }
  }
  const emails = (x.emails ?? []).reduce((t, e) => t + e.count, 0);
  if (emails > 0) {
    lines.push({
      key: "email",
      column: "email",
      label: "Emails",
      usd: emails * nn(i.emailUsd),
      note: `${(x.emails ?? []).map((e) => `${e.kind.replaceAll("_", " ")} ${e.count}`).join(", ")} × $${nn(i.emailUsd)}`,
    });
  }
  const wa = (x.whatsapp ?? []).reduce((t, e) => t + e.count, 0);
  if (wa > 0) {
    lines.push({
      key: "whatsapp",
      column: "email",
      label: "WhatsApp",
      usd: 0,
      info: true,
      note: `${wa} sent (${(x.whatsapp ?? []).map((e) => `${e.kind.replaceAll("_", " ")} ${e.count}`).join(", ")}): billed to the host's WABA`,
    });
  }
  if (nn(x.recordingGbDays) > 0) {
    lines.push({
      key: "rec-storage",
      column: "recording",
      label: `Recording storage (${store.label})`,
      usd: x.recordingGbDays * perGbDay,
      note: `${fmt(x.recordingGbDays)} GB-days held (${fmt(x.recordingGb, 2)} GB now); replay downloads $${store.egressPerGb}/GB`,
    });
  }
  const files = nn(x.mediaGbDays) + nn(x.knowledgeGbDays);
  if (files > 0) {
    lines.push({
      key: "files",
      column: "recording",
      label: "Media library and knowledge files",
      usd: files * perGbDay,
      note: `${fmt(x.mediaGb, 3)} GB media, ${fmt(x.knowledgeGb, 3)} GB documents held`,
    });
  }
  return lines;
}

export type PlatformCost = { lines: HostCostLine[]; usd: number; perSessionHourUsd: number };

/** What the platform costs over the range whoever uses it: the fixed bills, the boxes' idle
 *  hours, and spend with no host. */
export function platformCost(
  platform: AdminCostPlatform,
  rangeStart: string,
  rangeEnd: string,
  i: CostInputs,
  /** The session-hours the cost is spread over: everyone's, or only real hosts'. */
  shareHours: number = platform.sessionHours,
): PlatformCost {
  const months = hoursBetween(rangeStart, rangeEnd) / HOURS_PER_MONTH;
  const lines: HostCostLine[] = [];
  const add = (key: string, label: string, usd: number, note: string) => {
    if (usd > 0) lines.push({ key, column: "platform", label, usd, note });
  };
  const m = `${fmt(months, 2)} months`;
  add("supabase", "Supabase", nn(i.supabaseUsd) * months, `$${nn(i.supabaseUsd)}/month × ${m}`);
  add("workers", "Cloudflare Workers", nn(i.workersUsd) * months, `$${nn(i.workersUsd)}/month × ${m}`);
  const api = i.providers[i.provider];
  if (api.apiHost === "server") {
    add("api", `API server (${api.label})`, nn(api.apiServerMonthlyUsd) * months, `$${nn(api.apiServerMonthlyUsd)}/month × ${m}`);
  } else {
    add("api", "Cloud Run (API)", nn(i.cloudRunUsd) * months, `$${nn(i.cloudRunUsd)}/month × ${m}`);
  }
  for (const p of PROVIDERS) {
    const r = i.providers[p];
    if (nn(r.boxMonthlyUsd) === 0) continue;
    const hours = boxHours(p, platform, rangeStart, rangeEnd);
    const busy = nn(platform.byProvider?.[p]?.boxShareHours);
    const idle = Math.max(0, hours - busy);
    add(`idle-${p}`, `${r.label}: idle hours`, (idle * nn(r.boxMonthlyUsd)) / HOURS_PER_MONTH,
      `${fmt(idle, 0)} of ${fmt(hours, 0)} h with no session`);
  }
  add("ai", "AI with no host", nn(platform.unattributedAiUsd), "Sales chat and platform jobs (exact)");
  const store = RECORDING_STORES[i.recordingStore] ?? RECORDING_STORES.r2;
  add("rec", "Storage of deleted recordings (host unknown)",
    (nn(platform.unattributedRecordingGbDays) * store.perGbMonth) / DAYS_PER_MONTH,
    `${fmt(platform.unattributedRecordingGbDays)} GB-days`);
  const usd = lines.reduce((t, l) => t + l.usd, 0);
  return { lines, usd, perSessionHourUsd: nn(shareHours) > 0 ? usd / shareHours : 0 };
}

export type PricedHost = {
  host: AdminCostHost;
  lines: HostCostLine[];
  columns: Record<CostColumn, number>;
  totalUsd: number;
  sessionHours: number;
};

export type CostContext = {
  inputs: CostInputs;
  pools: Record<Provider, PoolRate>;
  platform: PlatformCost;
  /** Spread the platform cost over hosts by session-hours; off leaves it unallocated. */
  allocatePlatform: boolean;
  /** Apply the ignore list: ignored hosts leave the totals and the platform share's
   *  denominator, so real hosts carry it all. Off prices everyone as before. */
  hideIgnored: boolean;
};

/* Ignored hosts, hidden: their own costs leave the report, and the platform share is spread
 * over the remaining session-hours (platform.sessionHours less ignoredSessionHours), so a
 * test account's hours do not dilute what real hosts are shown to cost. Their usage still
 * fills the transfer pools and the boxes' busy hours: it happened. */
export function costContext(
  platform: AdminCostPlatform,
  rangeStart: string,
  rangeEnd: string,
  inputs: CostInputs,
  allocatePlatform: boolean,
  hideIgnored = false,
): CostContext {
  const shareHours = hideIgnored
    ? Math.max(0, nn(platform.sessionHours) - nn(platform.ignoredSessionHours))
    : nn(platform.sessionHours);
  return {
    inputs,
    pools: poolRates(platform, rangeStart, rangeEnd, inputs),
    platform: platformCost(platform, rangeStart, rangeEnd, inputs, shareHours),
    allocatePlatform,
    hideIgnored,
  };
}

/** The context one host is priced in: an ignored host, hidden, takes no platform share. */
export function hostContext(ctx: CostContext, host: AdminCostHost): CostContext {
  return ctx.hideIgnored && host.ignoredBy ? { ...ctx, allocatePlatform: false } : ctx;
}

function totals(lines: HostCostLine[]) {
  const columns = Object.fromEntries(COST_COLUMNS.map((c) => [c, 0])) as Record<CostColumn, number>;
  for (const l of lines) columns[l.column] += l.usd;
  return { columns, totalUsd: lines.reduce((t, l) => t + l.usd, 0) };
}

/** Lines with the same key (one per provider) folded into one. */
function merge(lines: HostCostLine[]): HostCostLine[] {
  const out = new Map<string, HostCostLine>();
  for (const l of lines) {
    const k = `${l.column}:${l.key}:${l.label}`;
    const prev = out.get(k);
    if (prev) out.set(k, { ...prev, usd: prev.usd + l.usd, note: `${prev.note}; ${l.note}` });
    else out.set(k, l);
  }
  return [...out.values()];
}

function shareLine(hours: number, ctx: CostContext): HostCostLine[] {
  if (!ctx.allocatePlatform || hours <= 0 || ctx.platform.perSessionHourUsd <= 0) return [];
  return [{
    key: "platform-share",
    column: "platform",
    label: "Platform share",
    usd: hours * ctx.platform.perSessionHourUsd,
    note: `${fmt(hours, 2)} session-hours × $${ctx.platform.perSessionHourUsd.toFixed(4)}/h`,
  }];
}

export function priceHost(host: AdminCostHost, outer: CostContext): PricedHost {
  const ctx = hostContext(outer, host);
  const session: HostCostLine[] = [];
  let sessionHours = 0;
  for (const [p, u] of Object.entries(host.byProvider ?? {})) {
    session.push(...priceUsage(u, p, ctx.inputs, ctx.pools));
    sessionHours += nn(u.sessionHours);
  }
  const lines = [...merge(session), ...priceExtras(host, ctx.inputs), ...shareLine(sessionHours, ctx)];
  return { host, lines, ...totals(lines), sessionHours };
}

export function priceSession(s: AdminCostSession, ctx: CostContext) {
  const lines = [...priceUsage(s.usage, s.provider, ctx.inputs, ctx.pools), ...shareLine(nn(s.usage.sessionHours), ctx)];
  return { lines, ...totals(lines) };
}

/** Hosts priced and sorted, most expensive first. */
export function priceHosts(hosts: AdminCostHost[], ctx: CostContext): PricedHost[] {
  return hosts.map((h) => priceHost(h, ctx)).sort((a, b) => b.totalUsd - a.totalUsd || a.host.email.localeCompare(b.host.email));
}

export type PricedReport = {
  /** Hosts not on the ignore list. */
  counted: PricedHost[];
  /** Hosts on it, priced without a platform share when hidden. */
  ignored: PricedHost[];
  /** What the report's total is: counted hosts, plus the ignored when they are not hidden. */
  totalUsd: number;
  ignoredUsd: number;
};

/** Every host priced, split by the ignore list. */
export function priceReport(hosts: AdminCostHost[], ctx: CostContext): PricedReport {
  const counted = priceHosts(hosts.filter((h) => !h.ignoredBy), ctx);
  const ignored = priceHosts(hosts.filter((h) => h.ignoredBy), ctx);
  const sum = (p: PricedHost[]) => p.reduce((t, x) => t + x.totalUsd, 0);
  const ignoredUsd = sum(ignored);
  return { counted, ignored, ignoredUsd, totalUsd: sum(counted) + (ctx.hideIgnored ? 0 : ignoredUsd) };
}

/** The hosts the table and the CSV show: the ignored ones only when not hidden. */
export function visibleHosts(r: PricedReport, hideIgnored: boolean): PricedHost[] {
  return hideIgnored ? r.counted : [...r.counted, ...r.ignored];
}

// ---------------------------------------------------------------- ranges and export

export type RangePreset = "month" | "last-month" | "all" | "custom";

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A preset's dates (inclusive, local calendar). All time is empty. */
export function presetRange(p: Exclude<RangePreset, "custom">, now: Date): { from: string; to: string } {
  if (p === "all") return { from: "", to: "" };
  if (p === "month") {
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  }
  return {
    from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
  };
}

const csvCell = (v: string | number) => {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(4) : "") : v;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** The host table as CSV, in dollars and rupees. */
export function hostsCsv(priced: PricedHost[], inrPerUsd: number): string {
  const head = [
    "Host", "Email", "Session hours", "Total USD", "Total INR", ...COST_COLUMNS.map((c) => `${COLUMN_LABELS[c]} USD`), "Ignored",
  ];
  return toCsv([
    head,
    ...priced.map((p) => [
      p.host.name,
      p.host.email,
      p.sessionHours,
      p.totalUsd,
      p.totalUsd * inrPerUsd,
      ...COST_COLUMNS.map((c) => p.columns[c]),
      p.host.ignoredBy ? "yes" : "",
    ]),
  ]);
}

/** One host's sessions as CSV, each with its cost breakdown. */
export function sessionsCsv(sessions: AdminCostSession[], ctx: CostContext): string {
  const cols: CostColumn[] = ["delivery", "meetings", "video", "recording", "platform"];
  return toCsv([
    ["Started", "Session", "Kind", "Delivery", "Provider", "Attendees", "Minutes", "Total USD", ...cols.map((c) => `${COLUMN_LABELS[c]} USD`)],
    ...sessions.map((s) => {
      const p = priceSession(s, ctx);
      return [
        s.startedAt,
        s.topic,
        s.kind,
        s.delivery,
        s.provider,
        s.usage.attendees,
        Math.round(nn(s.usage.sessionHours) * 60),
        p.totalUsd,
        ...cols.map((c) => p.columns[c]),
      ];
    }),
  ]);
}
