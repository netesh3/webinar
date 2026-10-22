/* What the platform costs us a month, and one coach's share of it, from how coaches run
 * webinars, meetings and simulives. The admin Cost calculator tab
 * (components/admin-cost-calculator.tsx) is this function with inputs.
 *
 * Every price is an input with a default, because the defaults go stale and an admin
 * checking a quote should not need a deploy to try a new one. The usage inputs describe the
 * average coach; fixed costs (the video server box, the API host, Supabase, Workers) are the
 * platform's and are spread over `coaches`. Transfer pools (DigitalOcean pools every
 * droplet's allowance; Hetzner includes ~20 TB per server, treated here as a pool too) are
 * platform-wide, so overage is worked out for all coaches together and shared back by GB.
 *
 * Provider defaults, as of 2026-10-22. From the repo (deploy/digitalocean/README.md,
 * deploy/livekit-hetzner/README.md, PLAN.md, lib/admin-costs.ts):
 *   DigitalOcean c-4 $84/mo ($0.125/h), 5 TB pooled, then $0.01/GiB.
 *   Hetzner CX33 ~€8.49/mo, ~20 TB included, then ~€1/TB.
 *   GCP Mumbai: e2-standard-2 SFU ~$0.07/h and c2d-highcpu-2 worker ~$0.09/h, both started
 *   per session; internet egress ~$0.12/GB, no pool; the API on Cloud Run.
 * ASSUMED (not in the repo; check before quoting): DO c-2 $42/mo ($0.0625/h) with 4 TB;
 * DO s-2vcpu-4gb API droplet $24/mo with 4 TB; Hetzner hourly CX33 for an extra render
 * server ~$0.015/h; a Hetzner CX23 API server ~$5/mo; €1 ≈ $1.08; Cloud Run compute ~$10/mo.
 *
 * Pure: no React, no DOM, so it runs under node tests. */

import { GB_PER_MBPS_HOUR, GCP_EGRESS_PER_GB, stageMbps } from "./admin-costs.ts";

export type Delivery = "edge" | "webrtc";
export type Provider = "gcp" | "hetzner" | "do";
export type ApiHost = "cloudrun" | "server";
export type RecordingStore = "r2" | "b2";
export type CostGroup = "delivery" | "meetings" | "recording" | "ai" | "messaging" | "fixed" | "info";

export const PROVIDERS: Provider[] = ["gcp", "hetzner", "do"];

export const GROUP_LABELS: Record<CostGroup, string> = {
  delivery: "Delivery (webinars, simulives)",
  meetings: "Meetings",
  recording: "Recording",
  ai: "AI",
  messaging: "Messaging",
  fixed: "Fixed and shared",
  info: "Not billed to us (capacity and pass-through)",
};

/** Per GB stored a month, and per GB downloaded (R2 has no egress fee). */
export const RECORDING_STORES: Record<RecordingStore, { label: string; perGbMonth: number; egressPerGb: number }> = {
  r2: { label: "Cloudflare R2", perGbMonth: 0.015, egressPerGb: 0 },
  b2: { label: "Backblaze B2", perGbMonth: 0.006, egressPerGb: 0.01 },
};

/** Everything that changes with the video provider. Each is editable per provider. */
export type ProviderRates = {
  label: string;
  /** An always-on SFU box a month (0 when the SFU is started per session instead). */
  boxMonthlyUsd: number;
  /** Transfer the box brings to the pool, TB a month. */
  boxIncludedTb: number;
  /** CPU cores on the box, for the captions capacity line. */
  boxCores: number;
  /** A per-session SFU an hour (0 when the box is always on). */
  sfuPerHour: number;
  /** A render/egress worker an hour. */
  workerPerHour: number;
  /** Transfer a worker brings to the pool for a full month, prorated by the hours it runs. */
  workerIncludedTb: number;
  /** The first edge webinar renders on the box; only concurrent ones need a worker. */
  workerColocated: boolean;
  /** Composite recordings (standard delivery, meetings) run on the box for free. */
  compositeOnBox: boolean;
  /** Beyond the pool, per GB. */
  overagePerGb: number;
  apiHost: ApiHost;
  /** The API on its own server a month (when apiHost is "server"). */
  apiServerMonthlyUsd: number;
  apiServerIncludedTb: number;
};

export const DEFAULT_PROVIDERS: Record<Provider, ProviderRates> = {
  gcp: {
    label: "GCP (Mumbai)",
    boxMonthlyUsd: 0,
    boxIncludedTb: 0,
    boxCores: 2,
    sfuPerHour: 0.07,
    workerPerHour: 0.09,
    workerIncludedTb: 0,
    workerColocated: false,
    compositeOnBox: false,
    overagePerGb: GCP_EGRESS_PER_GB,
    apiHost: "cloudrun",
    apiServerMonthlyUsd: 24,
    apiServerIncludedTb: 0,
  },
  hetzner: {
    label: "Hetzner (CX33)",
    boxMonthlyUsd: 9.2,
    boxIncludedTb: 20,
    boxCores: 4,
    sfuPerHour: 0,
    workerPerHour: 0.015,
    workerIncludedTb: 20,
    workerColocated: true,
    compositeOnBox: true,
    overagePerGb: 0.00108,
    apiHost: "server",
    apiServerMonthlyUsd: 5,
    apiServerIncludedTb: 20,
  },
  do: {
    label: "DigitalOcean (BLR1 c-4)",
    boxMonthlyUsd: 84,
    boxIncludedTb: 5,
    boxCores: 4,
    sfuPerHour: 0,
    workerPerHour: 0.0625,
    workerIncludedTb: 4,
    workerColocated: true,
    compositeOnBox: false,
    // $0.01 per GiB, per GB.
    overagePerGb: 0.01 / 1.073741824,
    apiHost: "server",
    apiServerMonthlyUsd: 24,
    apiServerIncludedTb: 4,
  },
};

export type CostInputs = {
  provider: Provider;
  providers: Record<Provider, ProviderRates>;
  /** Coaches sharing the fixed costs and the transfer pool. */
  coaches: number;

  // Webinars, per coach.
  webinarsPerMonth: number;
  hoursPerWebinar: number;
  viewersPerWebinar: number;
  /** Share of the session the average viewer watches, 0–100. */
  watchPercent: number;
  /** Everyone on the stage, the host included. */
  onStage: number;
  delivery: Delivery;
  /** Most edge webinars live at once across the platform; each beyond the first needs a render worker. */
  peakConcurrentEdge: number;
  /** Hours a month each extra render worker runs. */
  extraRenderHoursEach: number;

  // Meetings, per coach.
  meetingsPerMonth: number;
  participantsPerMeeting: number;
  hoursPerMeeting: number;
  /** What one participant downloads an hour: ~0.6 GB ≈ 1.3 Mbps with the simulcast ladder. */
  meetingGbPerParticipantHour: number;

  // Simulives, per coach.
  simulivesPerMonth: number;
  hoursPerSimulive: number;
  viewersPerSimulive: number;
  simuliveWatchPercent: number;

  // Recordings.
  recording: boolean;
  recordWebinarsPercent: number;
  recordMeetingsPercent: number;
  recordingMonths: number;
  recordingStore: RecordingStore;
  /** Hours of each webinar recording people watch back, all viewers together. */
  replayHoursPerRecording: number;
  /** Stored size of a composite-recorded hour (standard delivery, meetings). */
  recordingGbPerHour: number;

  // Captions (capacity only).
  captionsPercent: number;
  liveCaptionCores: number;
  /** The after-session large-model run, as a share of the session's length. */
  finalCaptionFactor: number;
  finalCaptionCores: number;

  // AI.
  ai: boolean;
  aiInPerM: number;
  aiOutPerM: number;
  embedPerM: number;
  aiHostMonthlyUsd: number;
  recapInKPerHour: number;
  recapOutKPerHour: number;
  qaInK: number;
  qaOutK: number;
  draftInK: number;
  draftOutK: number;
  draftsPerSession: number;
  autoAnswersPerSimulive: number;
  leadsInK: number;
  leadsOutK: number;
  followupInK: number;
  followupOutK: number;
  leadsPerWebinar: number;
  harvestInK: number;
  harvestOutK: number;
  libraryWordsPerMonth: number;
  questionsPerSession: number;
  tokensPerQuestion: number;

  // Messaging.
  emailsPerRegistrant: number;
  emailsPerMeetingParticipant: number;
  emailUsd: number;
  waMarketingPerRegistrant: number;
  waUtilityPerRegistrant: number;
  waMarketingInr: number;
  waUtilityInr: number;

  // Fixed.
  supabaseUsd: number;
  cloudRunUsd: number;
  workersUsd: number;
  bunnyMinUsd: number;

  // Rates.
  edgeVideoKbps: number;
  edgeAudioKbps: number;
  cdnPerGb: number;
  /** How many CDN edge locations pull each segment from the origin. */
  originPulls: number;
  /** Cloud Run's internet egress per GB (the API, when it runs there). */
  cloudRunEgressPerGb: number;
  /** Minutes a worker or SFU runs around each session: boot before, drain after. */
  warmupMinutes: number;
  /** What one WebRTC viewer pulls from the SFU (a 720p stage plus audio). */
  webrtcViewerMbps: number;
  /** What the API sends each viewer an hour: the event stream, chat, Q&A, attendance beats. */
  apiMbPerViewerHour: number;

  inrPerUsd: number;
  /** What the coach pays a month, in rupees. 0 skips the margin. */
  priceInr: number;
  priceIncludesGst: boolean;
  paymentFeePercent: number;
};

export const DEFAULT_INPUTS: CostInputs = {
  provider: "do",
  providers: DEFAULT_PROVIDERS,
  coaches: 20,

  webinarsPerMonth: 8,
  hoursPerWebinar: 1.5,
  viewersPerWebinar: 300,
  watchPercent: 70,
  onStage: 2,
  delivery: "edge",
  peakConcurrentEdge: 2,
  extraRenderHoursEach: 24,

  meetingsPerMonth: 25,
  participantsPerMeeting: 10,
  hoursPerMeeting: 1,
  meetingGbPerParticipantHour: 0.6,

  simulivesPerMonth: 4,
  hoursPerSimulive: 1,
  viewersPerSimulive: 100,
  simuliveWatchPercent: 60,

  recording: true,
  recordWebinarsPercent: 100,
  recordMeetingsPercent: 100,
  recordingMonths: 3,
  recordingStore: "r2",
  replayHoursPerRecording: 30,
  recordingGbPerHour: 1.75,

  captionsPercent: 100,
  liveCaptionCores: 1,
  finalCaptionFactor: 0.75,
  finalCaptionCores: 2,

  ai: true,
  aiInPerM: 0.05,
  aiOutPerM: 0.4,
  embedPerM: 0.02,
  aiHostMonthlyUsd: 2,
  recapInKPerHour: 14,
  recapOutKPerHour: 3,
  qaInK: 20,
  qaOutK: 5,
  draftInK: 3.5,
  draftOutK: 0.6,
  draftsPerSession: 10,
  autoAnswersPerSimulive: 20,
  leadsInK: 10,
  leadsOutK: 2,
  followupInK: 1,
  followupOutK: 0.3,
  leadsPerWebinar: 30,
  harvestInK: 3,
  harvestOutK: 1,
  libraryWordsPerMonth: 20000,
  questionsPerSession: 40,
  tokensPerQuestion: 40,

  emailsPerRegistrant: 4,
  emailsPerMeetingParticipant: 1,
  emailUsd: 0.0002,
  waMarketingPerRegistrant: 1,
  waUtilityPerRegistrant: 2,
  waMarketingInr: 0.78,
  waUtilityInr: 0.12,

  supabaseUsd: 25,
  cloudRunUsd: 10,
  workersUsd: 5,
  bunnyMinUsd: 1,

  edgeVideoKbps: 1000,
  edgeAudioKbps: 96,
  cdnPerGb: 0.005,
  originPulls: 3,
  cloudRunEgressPerGb: GCP_EGRESS_PER_GB,
  warmupMinutes: 10,
  webrtcViewerMbps: 1.5,
  apiMbPerViewerHour: 3,

  inrPerUsd: 100,
  priceInr: 4999,
  priceIncludesGst: true,
  paymentFeePercent: 2,
};

/** HLS segments and HTTP add about 6% to the encoded bitrate. */
const HLS_OVERHEAD = 1.06;
const HOURS_PER_MONTH = 730;

/** GB one edge viewer downloads in an hour at the mix's bitrate. Also the size of an hour
 *  of edge recording, which records the running mix (#620). */
export function edgeGbPerViewerHour(videoKbps: number, audioKbps: number): number {
  return ((videoKbps + audioKbps) * HLS_OVERHEAD * 3600) / 8 / 1e6;
}

/** Tokens to dollars: thousands in and out at per-million prices. */
export function aiUsd(inK: number, outK: number, inPerM: number, outPerM: number): number {
  return (inK * inPerM + outK * outPerM) / 1000;
}

export type CostLine = {
  key: string;
  group: CostGroup;
  label: string;
  /** Per coach a month. 0 on info lines. */
  usd: number;
  note: string;
  info?: boolean;
};

export type CostResult = {
  provider: Provider;
  lines: CostLine[];
  groups: Record<CostGroup, number>;
  /** One coach a month, their share of fixed costs included. */
  monthUsd: number;
  /** Every coach together. */
  platformMonthUsd: number;
  coaches: number;
  webinarUsd: number;
  viewerHours: number;
  participantHours: number;
  recordedHours: number;
  sessions: number;
  perViewerHourUsd: number;
  perParticipantHourUsd: number;
  perRecordedHourUsd: number;
  aiPerSessionUsd: number;
  aiUncappedUsd: number;
  aiCapped: boolean;
  /** Platform transfer against the pool. Percent is null without a pool. */
  pool: { usedGb: number; includedGb: number; overageGb: number; percent: number | null };
  /** The meetings' traffic at GCP's egress price, for comparison. */
  meetingsOnGcpUsd: number;
  /** Box CPU-hours captions use a month, all coaches; capacity null without an always-on box. */
  captions: { coreHours: number; capacityCoreHours: number | null };
  /** Revenue after GST and the payment fee, per coach a month. Null without a price. */
  netRevenueUsd: number | null;
  marginUsd: number | null;
  marginPercent: number | null;
};

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const pct = (n: number) => Math.min(100, nonNeg(n)) / 100;
const fmt = (n: number, digits = 0) => n.toLocaleString("en-IN", { maximumFractionDigits: digits });

/** Merge saved or partial inputs over the defaults, provider by provider. */
export function withDefaults(saved: Partial<CostInputs> | null | undefined): CostInputs {
  const s = saved && typeof saved === "object" ? saved : {};
  const providers = { ...DEFAULT_PROVIDERS };
  for (const p of PROVIDERS) providers[p] = { ...DEFAULT_PROVIDERS[p], ...(s.providers?.[p] ?? {}) };
  const provider = PROVIDERS.includes(s.provider as Provider) ? (s.provider as Provider) : DEFAULT_INPUTS.provider;
  return { ...DEFAULT_INPUTS, ...s, provider, providers };
}

export function calculateCost(raw: CostInputs): CostResult {
  const i = withDefaults(raw);
  const p = i.providers[i.provider];
  const coaches = Math.max(1, Math.round(nonNeg(i.coaches)));
  const warmup = nonNeg(i.warmupMinutes) / 60;
  const edge = i.delivery === "edge";
  const onServer = p.apiHost === "server";

  const webinars = nonNeg(i.webinarsPerMonth);
  const hours = nonNeg(i.hoursPerWebinar);
  const liveHours = webinars * hours;
  const viewerHours = liveHours * nonNeg(i.viewersPerWebinar) * pct(i.watchPercent);
  const stage = Math.max(1, Math.round(nonNeg(i.onStage)));

  const meetings = nonNeg(i.meetingsPerMonth);
  const meetingHours = meetings * nonNeg(i.hoursPerMeeting);
  const participantHours = meetingHours * nonNeg(i.participantsPerMeeting);

  const simulives = nonNeg(i.simulivesPerMonth);
  const simuliveViewerHours =
    simulives * nonNeg(i.hoursPerSimulive) * nonNeg(i.viewersPerSimulive) * pct(i.simuliveWatchPercent);

  const lines: CostLine[] = [];
  const add = (group: CostGroup, key: string, label: string, usd: number, note: string) => {
    if (usd > 0) lines.push({ key, group, label, usd, note });
  };
  const info = (group: CostGroup, key: string, label: string, note: string) =>
    lines.push({ key, group, label, usd: 0, note, info: true });

  // ---- Traffic, per coach, GB. All of it leaves the provider and meets the pool.
  const gbPerViewerHour = edgeGbPerViewerHour(nonNeg(i.edgeVideoKbps), nonNeg(i.edgeAudioKbps));
  const [lo, hi] = stageMbps(stage);
  const stageGb = liveHours * ((lo + hi) / 2) * GB_PER_MBPS_HOUR;
  const originGb = edge ? liveHours * nonNeg(i.originPulls) * gbPerViewerHour : 0;
  const webrtcGb = edge ? 0 : viewerHours * nonNeg(i.webrtcViewerMbps) * GB_PER_MBPS_HOUR;
  const meetingGb = participantHours * nonNeg(i.meetingGbPerParticipantHour);
  const apiGb =
    ((viewerHours + simuliveViewerHours + participantHours) * nonNeg(i.apiMbPerViewerHour)) / 1000;

  // ---- Recordings, per coach.
  const rec = i.recording;
  const recWebinarHours = rec ? liveHours * pct(i.recordWebinarsPercent) : 0;
  const recMeetingHours = rec ? meetingHours * pct(i.recordMeetingsPercent) : 0;
  const recWebinarCount = rec ? webinars * pct(i.recordWebinarsPercent) : 0;
  const recMeetingCount = rec ? meetings * pct(i.recordMeetingsPercent) : 0;
  const compositeGbPerHour = nonNeg(i.recordingGbPerHour);
  const webinarRecGbPerHour = edge ? gbPerViewerHour : compositeGbPerHour;
  const webinarRecGb = recWebinarHours * webinarRecGbPerHour;
  const meetingRecGb = recMeetingHours * compositeGbPerHour;
  const recordedGb = webinarRecGb + meetingRecGb;
  // Composite workers: every recorded meeting, and recorded webinars on standard delivery.
  const compositeSessions = recMeetingCount + (edge ? 0 : recWebinarCount);
  const compositeHours = recMeetingHours + (edge ? 0 : recWebinarHours) + compositeSessions * warmup;
  const compositeWorkerHours = p.compositeOnBox ? 0 : compositeHours;

  // ---- Workers. Not co-located: one per live edge webinar. Co-located: the box renders the
  // first and each concurrent one beyond it gets its own worker (platform-wide).
  const edgeWorkerHoursPerCoach = edge && !p.workerColocated ? webinars * (hours + warmup) : 0;
  const extraRenderers = edge && webinars > 0 && p.workerColocated ? Math.max(0, Math.round(nonNeg(i.peakConcurrentEdge)) - 1) : 0;
  const extraStarts = hours > 0 ? Math.ceil(nonNeg(i.extraRenderHoursEach) / hours) : 0;
  const extraRenderHoursPlatform = extraRenderers * (nonNeg(i.extraRenderHoursEach) + extraStarts * warmup);
  const workerHoursPlatform =
    (edgeWorkerHoursPerCoach + compositeWorkerHours) * coaches + extraRenderHoursPlatform;

  // ---- The pool, platform-wide.
  const pooledGbPerCoach = stageGb + originGb + webrtcGb + meetingGb + recordedGb + (onServer ? apiGb : 0);
  const includedGb =
    (nonNeg(p.boxIncludedTb) +
      (onServer ? nonNeg(p.apiServerIncludedTb) : 0) +
      (nonNeg(p.workerIncludedTb) * workerHoursPlatform) / HOURS_PER_MONTH) *
    1000;
  const usedGb = pooledGbPerCoach * coaches;
  const overageGb = Math.max(0, usedGb - includedGb);
  const overageUsd = overageGb * nonNeg(p.overagePerGb);
  // Shared back by GB: a coach's line is its GB at the pool's effective rate.
  const perGb = usedGb > 0 ? overageUsd / usedGb : 0;
  const poolNote = includedGb > 0 ? "beyond the pool" : `at $${nonNeg(p.overagePerGb).toFixed(3)}/GB`;

  // ---- Delivery.
  if (edge) {
    add(
      "delivery",
      "cdn",
      "CDN (Bunny)",
      viewerHours * gbPerViewerHour * nonNeg(i.cdnPerGb),
      `${fmt(viewerHours)} attendee-hours × ${gbPerViewerHour.toFixed(2)} GB`,
    );
    add(
      "delivery",
      "origin",
      "Origin → CDN transfer",
      originGb * perGb,
      `${fmt(originGb, 1)} GB, ${fmt(nonNeg(i.originPulls))} CDN locations pull the stream, ${poolNote}`,
    );
    add(
      "delivery",
      "worker",
      "Edge render worker",
      edgeWorkerHoursPerCoach * nonNeg(p.workerPerHour),
      "One per live edge webinar, plus its warm-up",
    );
    add(
      "delivery",
      "render-extra",
      "Extra render workers (concurrency)",
      (extraRenderHoursPlatform * nonNeg(p.workerPerHour)) / coaches,
      `${extraRenderers} beyond the first of ${fmt(nonNeg(i.peakConcurrentEdge))} concurrent, ${fmt(nonNeg(i.extraRenderHoursEach))} h each, shared by ${coaches}`,
    );
  } else {
    add(
      "delivery",
      "webrtc",
      "WebRTC viewers (SFU transfer)",
      webrtcGb * perGb,
      `${fmt(webrtcGb)} GB at ${nonNeg(i.webrtcViewerMbps)} Mbps, ${poolNote}`,
    );
  }
  add(
    "delivery",
    "stage",
    "Stage traffic",
    stageGb * perGb,
    `${stage} on stage, ${fmt(stageGb, 1)} GB, ${poolNote}`,
  );
  add(
    "delivery",
    "sfu",
    "Video server (per webinar)",
    webinars * (hours + warmup) * nonNeg(p.sfuPerHour),
    "Started for each webinar and stopped after",
  );
  add(
    "delivery",
    "api",
    onServer ? "API transfer (events, chat)" : "API egress from Cloud Run",
    onServer ? apiGb * perGb : apiGb * nonNeg(i.cloudRunEgressPerGb),
    `${fmt(apiGb, 1)} GB (${nonNeg(i.apiMbPerViewerHour)} MB per attendee/participant-hour)`,
  );
  if (simulives > 0) {
    info(
      "delivery",
      "simulive",
      "Simulive playback",
      `${fmt(simuliveViewerHours)} viewer-hours from R2 via the recordings domain (public bucket behind Cloudflare): $0 egress, no SFU. Only API traffic, counted above.`,
    );
  }

  // ---- Meetings.
  const meetingNote = `${fmt(participantHours)} participant-hours × ${nonNeg(i.meetingGbPerParticipantHour)} GB = ${fmt(meetingGb)} GB, ${poolNote}; on GCP $${(meetingGb * GCP_EGRESS_PER_GB).toFixed(2)}`;
  if (meetingGb > 0 && meetingGb * perGb === 0) {
    info("meetings", "meeting-transfer", "Meeting transfer (SFU downlink)", `Within the pool. ${meetingNote}`);
  }
  add(
    "meetings",
    "meeting-transfer",
    "Meeting transfer (SFU downlink)",
    meetingGb * perGb,
    meetingNote,
  );
  add(
    "meetings",
    "meeting-sfu",
    "Video server (per meeting)",
    meetings * (nonNeg(i.hoursPerMeeting) + warmup) * nonNeg(p.sfuPerHour),
    "Started for each meeting and stopped after",
  );

  // ---- Recording.
  if (rec) {
    const store = RECORDING_STORES[i.recordingStore] ?? RECORDING_STORES.r2;
    add(
      "recording",
      "rec-worker",
      "Composite recording workers",
      compositeWorkerHours * nonNeg(p.workerPerHour),
      `${fmt(compositeHours, 1)} h for meetings${edge ? "" : " and standard-delivery webinars"}; edge recordings reuse the mix`,
    );
    add(
      "recording",
      "rec-upload",
      `Recording upload (→ ${store.label})`,
      recordedGb * perGb,
      `${fmt(recordedGb, 1)} GB a month leaves the video server once, ${poolNote}`,
    );
    // Steady state: every month adds this much, and each month's is kept for N months.
    add(
      "recording",
      "rec-storage",
      `Recording storage (${store.label})`,
      recordedGb * nonNeg(i.recordingMonths) * store.perGbMonth,
      `${fmt(recordedGb * nonNeg(i.recordingMonths), 1)} GB held: webinars ${webinarRecGbPerHour.toFixed(2)} GB/h (${edge ? "mix" : "composite"}), meetings ${compositeGbPerHour} GB/h, kept ${fmt(nonNeg(i.recordingMonths))} months`,
    );
    add(
      "recording",
      "rec-replay",
      `Recording replay egress (${store.label})`,
      recWebinarCount * nonNeg(i.replayHoursPerRecording) * webinarRecGbPerHour * store.egressPerGb,
      `${fmt(recWebinarCount * nonNeg(i.replayHoursPerRecording))} replay hours a month`,
    );
  }

  // ---- Captions: capacity, not cash.
  const sessionHours = liveHours + meetingHours;
  const captionCoreHours =
    sessionHours * pct(i.captionsPercent) * nonNeg(i.liveCaptionCores) +
    sessionHours * pct(i.captionsPercent) * nonNeg(i.finalCaptionFactor) * nonNeg(i.finalCaptionCores);
  const capacityCoreHours = p.boxMonthlyUsd > 0 ? nonNeg(p.boxCores) * HOURS_PER_MONTH : null;
  if (captionCoreHours > 0) {
    const platform = captionCoreHours * coaches;
    info(
      "info",
      "captions",
      "Captions (live + after-session run)",
      `$0 cash. ${fmt(captionCoreHours)} box CPU-hours a coach, ${fmt(platform)} for ${coaches}` +
        (capacityCoreHours
          ? ` (${fmt((platform / capacityCoreHours) * 100)}% of the box's ${fmt(capacityCoreHours)} core-hours)`
          : "") +
        ". Replays and simulives reuse the VTT.",
    );
  }

  // ---- AI, capped per host.
  const sessions = webinars + meetings + simulives;
  let aiUncappedUsd = 0;
  const aiCap = nonNeg(i.aiHostMonthlyUsd);
  if (i.ai) {
    const r = (inK: number, outK: number) => aiUsd(inK, outK, nonNeg(i.aiInPerM), nonNeg(i.aiOutPerM));
    const leads = webinars * nonNeg(i.leadsPerWebinar);
    const questions = (webinars + simulives) * nonNeg(i.questionsPerSession);
    const parts: [string, string, number, string][] = [
      ["ai-recap", "Recap and chapters", r(nonNeg(i.recapInKPerHour) * sessionHours, nonNeg(i.recapOutKPerHour) * sessionHours), `${fmt(sessionHours, 1)} session-hours`],
      ["ai-qa", "Q&A grouping", r(nonNeg(i.qaInK) * webinars, nonNeg(i.qaOutK) * webinars), `${fmt(webinars)} webinars`],
      ["ai-drafts", "Answer drafts", r(nonNeg(i.draftInK) * webinars * nonNeg(i.draftsPerSession), nonNeg(i.draftOutK) * webinars * nonNeg(i.draftsPerSession)), `${fmt(webinars * nonNeg(i.draftsPerSession))} drafts`],
      ["ai-auto", "Auto mode answers (simulive)", r(nonNeg(i.draftInK) * simulives * nonNeg(i.autoAnswersPerSimulive), nonNeg(i.draftOutK) * simulives * nonNeg(i.autoAnswersPerSimulive)), `${fmt(simulives * nonNeg(i.autoAnswersPerSimulive))} answers`],
      ["ai-leads", "Hot leads", r(nonNeg(i.leadsInK) * webinars, nonNeg(i.leadsOutK) * webinars), `${fmt(webinars)} webinars`],
      ["ai-followup", "Follow-up writer", r(nonNeg(i.followupInK) * leads, nonNeg(i.followupOutK) * leads), `${fmt(leads)} leads`],
      ["ai-harvest", "Past-answer harvest", r(nonNeg(i.harvestInK) * webinars, nonNeg(i.harvestOutK) * webinars), `${fmt(webinars)} webinars`],
      ["ai-embed", "Knowledge embeddings", ((nonNeg(i.libraryWordsPerMonth) * 1.33 + questions * nonNeg(i.tokensPerQuestion)) * nonNeg(i.embedPerM)) / 1e6, `${fmt(nonNeg(i.libraryWordsPerMonth))} library words + ${fmt(questions)} questions`],
    ];
    aiUncappedUsd = parts.reduce((t, x) => t + x[2], 0);
    const scale = aiCap > 0 && aiUncappedUsd > aiCap ? aiCap / aiUncappedUsd : 1;
    for (const [key, label, usd, note] of parts) {
      add("ai", key, label, usd * scale, scale < 1 ? `${note}; capped at $${aiCap}/host` : note);
    }
  }
  const aiCapped = aiCap > 0 && aiUncappedUsd > aiCap;

  // ---- Messaging.
  const registrants = webinars * nonNeg(i.viewersPerWebinar);
  const emails =
    registrants * nonNeg(i.emailsPerRegistrant) +
    meetings * nonNeg(i.participantsPerMeeting) * nonNeg(i.emailsPerMeetingParticipant);
  add("messaging", "email", "Emails", emails * nonNeg(i.emailUsd), `${fmt(emails)} emails × $${nonNeg(i.emailUsd)}`);
  const waInr =
    registrants * (nonNeg(i.waMarketingPerRegistrant) * nonNeg(i.waMarketingInr) + nonNeg(i.waUtilityPerRegistrant) * nonNeg(i.waUtilityInr));
  info(
    "info",
    "whatsapp",
    "WhatsApp",
    `Billed to the coach's WABA, not us: ₹${nonNeg(i.waMarketingInr)} marketing, ₹${nonNeg(i.waUtilityInr)} utility, service replies free. ≈ ₹${fmt(waInr)} a month to the coach.`,
  );

  // ---- Fixed and shared, spread over the coaches.
  const share = (usd: number) => usd / coaches;
  const fixed = (key: string, label: string, usd: number) =>
    add("fixed", key, label, share(nonNeg(usd)), `$${nonNeg(usd).toFixed(2)} a month over ${coaches} coaches`);
  fixed("box", `Video server box (${p.label})`, p.boxMonthlyUsd);
  if (onServer) fixed("api-server", "API server", p.apiServerMonthlyUsd);
  else fixed("cloudrun", "Cloud Run (API compute, estimate)", i.cloudRunUsd);
  fixed("supabase", "Supabase", i.supabaseUsd);
  fixed("workers", "Cloudflare Workers", i.workersUsd);
  const cdnPlatform = (lines.find((l) => l.key === "cdn")?.usd ?? 0) * coaches;
  fixed("bunny-min", "Bunny monthly minimum top-up", Math.max(0, nonNeg(i.bunnyMinUsd) - cdnPlatform));

  // ---- Totals.
  const groups = { delivery: 0, meetings: 0, recording: 0, ai: 0, messaging: 0, fixed: 0, info: 0 } as Record<CostGroup, number>;
  for (const l of lines) groups[l.group] += l.usd;
  const monthUsd = lines.reduce((t, l) => t + l.usd, 0);
  const rate = nonNeg(i.inrPerUsd) || 1;
  let netRevenueUsd: number | null = null;
  if (nonNeg(i.priceInr) > 0) {
    const exGst = i.priceIncludesGst ? i.priceInr / 1.18 : i.priceInr;
    netRevenueUsd = (exGst * (1 - pct(i.paymentFeePercent))) / rate;
  }
  const marginUsd = netRevenueUsd == null ? null : netRevenueUsd - monthUsd;
  const recordedHours = recWebinarHours + recMeetingHours;
  const anyUsage = webinars + meetings + simulives > 0;
  return {
    provider: i.provider,
    lines,
    groups,
    monthUsd: anyUsage ? monthUsd : 0,
    platformMonthUsd: anyUsage ? monthUsd * coaches : 0,
    coaches,
    webinarUsd: webinars > 0 ? groups.delivery / webinars : 0,
    viewerHours,
    participantHours,
    recordedHours,
    sessions,
    perViewerHourUsd: viewerHours > 0 ? groups.delivery / viewerHours : 0,
    perParticipantHourUsd: participantHours > 0 ? groups.meetings / participantHours : 0,
    perRecordedHourUsd: recordedHours > 0 ? groups.recording / recordedHours : 0,
    aiPerSessionUsd: sessions > 0 ? groups.ai / sessions : 0,
    aiUncappedUsd,
    aiCapped,
    pool: { usedGb, includedGb, overageGb, percent: includedGb > 0 ? (usedGb / includedGb) * 100 : null },
    meetingsOnGcpUsd: meetingGb * GCP_EGRESS_PER_GB,
    captions: { coreHours: captionCoreHours * coaches, capacityCoreHours },
    netRevenueUsd,
    marginUsd,
    marginPercent: netRevenueUsd && marginUsd != null ? (marginUsd / netRevenueUsd) * 100 : null,
  };
}

/** The same inputs on every provider, for the side-by-side. */
export function compareProviders(inputs: CostInputs): Record<Provider, CostResult> {
  return Object.fromEntries(PROVIDERS.map((p) => [p, calculateCost({ ...inputs, provider: p })])) as Record<
    Provider,
    CostResult
  >;
}
