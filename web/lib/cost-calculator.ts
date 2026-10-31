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
 * deploy/livekit-box/README.md, PLAN.md, lib/admin-costs.ts):
 *   DigitalOcean c-4 $84/mo ($0.125/h), 5 TB pooled, then $0.01/GiB.
 *   Hetzner CX33 ~€8.49/mo, ~20 TB included, then ~€1/TB.
 *   GCP Mumbai: e2-standard-2 SFU ~$0.07/h and c2d-highcpu-2 worker ~$0.09/h, both started
 *   per session; internet egress ~$0.12/GB, no pool; the API on Cloud Run.
 * ASSUMED (not in the repo; check before quoting): DO c-2 $42/mo ($0.0625/h) with 4 TB;
 * DO s-2vcpu-4gb API droplet $24/mo with 4 TB; Hetzner hourly CX33 for an extra render
 * server ~$0.015/h; a Hetzner CX23 API server ~$5/mo; €1 ≈ $1.08; Cloud Run compute ~$10/mo.
 *
 * Recently shipped features, each with labelled assumptions (2026-10-23):
 *   TURN relay (#655): a share of WebRTC participants relayed; their media is counted through
 *     the box once more (in and out). LiveKit's TURN is on the same box, so this is the
 *     conservative case. TLS termination is Caddy CPU, info only.
 *   AV1 (#649/#653): AV1-capable publishers (desktop Chrome/Edge, 8+ cores) send ~0.7× the
 *     bitrate to receivers that take AV1; Safari/iOS, weak devices and the recorder get the
 *     VP8/H264 backup at full rate. The backup doubles the publisher's uplink (ingress, free).
 *   Screen share keeps resolution (#639/#641): one full layer (no simulcast) to everyone,
 *     slides 2.5 Mbps VP9 / 4 H264, video 4 / 5, for the share's part of the session.
 *   Edge 1080p share profile (docs/edge-delivery.md): 1300 or 1600 kbps during shares.
 *   Recording retention (#650): 30 days, "Keep longer" 3 months at a time within the plan's
 *     quota (2 / 10 / 50 / 200 GiB). Edge recordings record the running mix: no compute (#620).
 *   Web push: browser push services are free; it replaces some reminder emails.
 *   Captions are English only (small.en / base.en): ~0.6× the multilingual CPU.
 *   AI Q&A only answers when retrieval finds something: skipped questions cost no model call.
 *
 * The admin's main view is a feature table (featureRows): one row per feature, on or off,
 * with its cost per coach and for every coach; the fixed platform costs (fixedRows), which
 * include the servers the coach count needs at peak, sit under it.
 *
 * Pure: no React, no DOM, so it runs under node tests. */

import { GB_PER_MBPS_HOUR, GCP_EGRESS_PER_GB, stageMbps } from "./admin-costs.ts";

export type Delivery = "edge" | "webrtc";
export type Provider = "gcp" | "hetzner" | "do";
export type ApiHost = "cloudrun" | "server";
export type RecordingStore = "r2" | "b2";
export type CostGroup = "delivery" | "meetings" | "recording" | "ai" | "messaging" | "fixed" | "info";

/* Every provider with rates: Hetzner stays for pricing sessions that ran on its server before it
 * was deleted (2026-10-26, lib/host-costs.ts), but the calculator only offers the servers we can
 * run on (CALCULATOR_PROVIDERS). */
export const PROVIDERS: Provider[] = ["gcp", "hetzner", "do"];
export const CALCULATOR_PROVIDERS: Provider[] = ["gcp", "do"];

/** What a coach can be given. Each is a row in the main table, on or off for every coach. */
export type FeatureKey =
  | "webinars"
  | "meetings"
  | "recording"
  | "simulive"
  | "captions"
  | "ai"
  | "youtube"
  | "messaging"
  | "push"
  | "turn"
  | "av1"
  | "edgeShare";

export const FEATURES: { key: FeatureKey; label: string; hint: string }[] = [
  { key: "webinars", label: "Webinars", hint: "Edge or WebRTC delivery, the stage, screen share" },
  { key: "meetings", label: "Meetings", hint: "SFU downlink, screen share" },
  { key: "recording", label: "Cloud recording", hint: "Upload, storage (30 days + Keep longer), replay" },
  { key: "simulive", label: "Simulive", hint: "Plays from R2: API traffic only" },
  { key: "captions", label: "Captions", hint: "English-only Whisper on the box: CPU, not cash" },
  { key: "ai", label: "AI", hint: "Recap, Q&A assistant, hot leads and follow-ups" },
  { key: "youtube", label: "YouTube streaming", hint: "RTMP push of the mix or the recording composite" },
  { key: "messaging", label: "Email and WhatsApp", hint: "Reminders and follow-ups; WhatsApp is the coach's" },
  { key: "push", label: "Push notifications", hint: "Free; replaces some reminder emails (in progress)" },
  { key: "turn", label: "TURN relay", hint: "Participants behind strict firewalls, relayed via the box" },
  { key: "av1", label: "AV1 video", hint: "Smaller camera video for capable devices" },
  { key: "edgeShare", label: "Edge 1080p share profile", hint: "Sharper slides for edge viewers, more CDN" },
];

/** On by default: everything shipped. Push is in progress and the 1080p share profile is optional. */
export const DEFAULT_FEATURES: Record<FeatureKey, boolean> = {
  webinars: true,
  meetings: true,
  recording: true,
  simulive: true,
  captions: true,
  ai: true,
  youtube: true,
  messaging: true,
  push: false,
  turn: true,
  av1: true,
  edgeShare: false,
};

/** Storage quota by plan (migrations 0148, 0179 and 0180), GiB: recordings and uploaded videos
 *  together. The attendee cap picks the plan; Starter is the grandfathered ₹3,999 plan. */
export const RECORDING_QUOTAS: { plan: string; cap: number | null; gib: number }[] = [
  { plan: "No plan", cap: null, gib: 2 },
  { plan: "Basic", cap: 100, gib: 2 },
  { plan: "Starter", cap: 200, gib: 10 },
  { plan: "Professional", cap: 300, gib: 10 },
  { plan: "Business", cap: 500, gib: 100 },
  { plan: "Enterprise", cap: 1000, gib: 500 },
];

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
  /** The SFU box a month if it ran all month (0 when the SFU is started per session instead). */
  boxMonthlyUsd: number;
  /** The box exists only while sessions need it (created on demand and deleted when idle,
   *  api/internal/api/sfu_box.go): billed for the hours it runs, at boxMonthlyUsd / 730 an hour. */
  boxOnDemand: boolean;
  /** Hours a month an on-demand box runs. 0 estimates it from the sessions: their hours, plus
   *  boxOverheadMinutes each (warm-up before, idle grace after). Admin → Video server shows the
   *  measured hours of the last 30 days. */
  boxHoursPerMonth: number;
  boxOverheadMinutes: number;
  /** Transfer the box brings to the pool, TB a month (prorated by the hours an on-demand box runs). */
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
    boxOnDemand: false,
    boxHoursPerMonth: 0,
    boxOverheadMinutes: 55,
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
    boxOnDemand: false,
    boxHoursPerMonth: 0,
    boxOverheadMinutes: 55,
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
    // Created on demand since 2026-10-23: 15 min warm-up + 40 min idle grace around sessions.
    boxOnDemand: true,
    boxHoursPerMonth: 0,
    boxOverheadMinutes: 55,
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
  /** Which features coaches get. */
  features: Record<FeatureKey, boolean>;

  // Webinars, per coach.
  webinarsPerMonth: number;
  hoursPerWebinar: number;
  viewersPerWebinar: number;
  /** Share of the session the average viewer watches, 0–100. */
  watchPercent: number;
  /** Everyone on the stage, the host included. */
  onStage: number;
  delivery: Delivery;
  /** Hours a month when sessions happen (evenings, mostly). Every coach's sessions are
   *  assumed spread over them, which sets the peak concurrency and so the servers needed. */
  busyHoursPerMonth: number;
  /** Sessions (webinars and meetings) one always-on box carries at once. ASSUMED. */
  boxSessionCapacity: number;

  // Meetings, per coach.
  meetingsPerMonth: number;
  participantsPerMeeting: number;
  hoursPerMeeting: number;
  /** What one participant downloads an hour of cameras: ~0.6 GB ≈ 1.3 Mbps with the simulcast ladder. */
  meetingGbPerParticipantHour: number;
  /** What one publisher uploads an hour (the camera's simulcast layers): ~0.75 GB ≈ 1.7 Mbps. */
  uplinkGbPerPublisherHour: number;

  // Screen share (#639/#641): one full layer to every subscriber.
  /** Share of a session someone is sharing, 0–100. */
  sharePercent: number;
  /** Of the shares, in video mode (the rest is slides), 0–100. */
  shareVideoPercent: number;
  /** Of the shares, sent as H264 (Safari, no VP9), 0–100. */
  shareH264Percent: number;
  shareSlidesVp9Mbps: number;
  shareSlidesH264Mbps: number;
  shareVideoVp9Mbps: number;
  shareVideoH264Mbps: number;

  // TURN (#655).
  /** WebRTC participants relayed through TURN, 0–100. */
  turnPercent: number;

  // AV1 (#649/#653).
  /** Publishers on AV1-capable devices (desktop Chrome/Edge, 8+ cores), 0–100. */
  av1PublisherPercent: number;
  /** Receivers that take AV1 (not Safari/iOS, weak devices or the recorder), 0–100. */
  av1ReceiverPercent: number;
  /** AV1's bitrate against VP8/H264 for the same picture. */
  av1BitrateFactor: number;

  // Edge 1080p share profile.
  /** The edge mix's video bitrate while somebody shares, with the profile on: 1300 or 1600. */
  edgeShareKbps: number;

  // YouTube.
  /** Webinars also streamed to YouTube, 0–100. */
  youtubePercent: number;

  // Simulives, per coach.
  simulivesPerMonth: number;
  hoursPerSimulive: number;
  viewersPerSimulive: number;
  simuliveWatchPercent: number;

  // Recordings.
  recordWebinarsPercent: number;
  recordMeetingsPercent: number;
  /** Default retention (RECORDINGS_RETENTION_DAYS). */
  retentionDays: number;
  /** Recordings the coach keeps longer, 0–100; within the plan's quota. */
  keepLongerPercent: number;
  /** How long Keep longer adds each time. */
  keepLongerMonths: number;
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
  /** English-only models (small.en / base.en) against the multilingual ones the cores were measured on. */
  captionsModelFactor: number;

  // AI.
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
  /** Questions the confidence gate answers without a model call (no retrieval hit), 0–100. */
  qaSkipPercent: number;

  // Messaging.
  emailsPerRegistrant: number;
  emailsPerMeetingParticipant: number;
  emailUsd: number;
  /** Reminder emails (every registrant email but the confirmation) that push replaces, 0–100. */
  pushReplacePercent: number;
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

  // Minimum price.
  /** Gross margin wanted on net revenue (after GST and the payment fee), 0–99. */
  targetMarginPercent: number;
  /** Support and overhead per coach a month, in rupees. */
  overheadInr: number;
  /** The plan's attendee cap; attendees beyond it are priced as overage. */
  planAttendeeCap: number;
};

export type Preset = "light" | "typical" | "heavy";

/** Usage presets for the minimum-price section. Typical is the defaults. */
export const PRESETS: Record<Preset, { label: string; usage: Partial<CostInputs> }> = {
  light: {
    label: "Light",
    usage: {
      webinarsPerMonth: 4,
      hoursPerWebinar: 1,
      viewersPerWebinar: 100,
      meetingsPerMonth: 10,
      participantsPerMeeting: 5,
      hoursPerMeeting: 1,
      simulivesPerMonth: 2,
      hoursPerSimulive: 1,
      viewersPerSimulive: 50,
    },
  },
  typical: {
    label: "Typical",
    usage: {
      webinarsPerMonth: 8,
      hoursPerWebinar: 1.5,
      viewersPerWebinar: 300,
      meetingsPerMonth: 25,
      participantsPerMeeting: 10,
      hoursPerMeeting: 1,
      simulivesPerMonth: 4,
      hoursPerSimulive: 1,
      viewersPerSimulive: 100,
    },
  },
  heavy: {
    label: "Heavy",
    usage: {
      webinarsPerMonth: 12,
      hoursPerWebinar: 2,
      viewersPerWebinar: 500,
      meetingsPerMonth: 40,
      participantsPerMeeting: 15,
      hoursPerMeeting: 1,
      simulivesPerMonth: 8,
      hoursPerSimulive: 1.5,
      viewersPerSimulive: 300,
    },
  },
};

/** Attendee caps by plan tier (types.PlanAttendeeCap, 31 Oct 2026): Basic, the grandfathered
 *  Starter, Professional, Business, Enterprise. */
export const PLAN_CAPS = [100, 200, 300, 500, 1000] as const;

export const DEFAULT_INPUTS: CostInputs = {
  provider: "do",
  providers: DEFAULT_PROVIDERS,
  coaches: 20,
  features: DEFAULT_FEATURES,

  webinarsPerMonth: 8,
  hoursPerWebinar: 1.5,
  viewersPerWebinar: 300,
  watchPercent: 70,
  onStage: 2,
  delivery: "edge",
  busyHoursPerMonth: 120,
  boxSessionCapacity: 10,

  meetingsPerMonth: 25,
  participantsPerMeeting: 10,
  hoursPerMeeting: 1,
  meetingGbPerParticipantHour: 0.6,
  uplinkGbPerPublisherHour: 0.75,

  sharePercent: 40,
  shareVideoPercent: 10,
  shareH264Percent: 30,
  shareSlidesVp9Mbps: 2.5,
  shareSlidesH264Mbps: 4,
  shareVideoVp9Mbps: 4,
  shareVideoH264Mbps: 5,

  turnPercent: 5,
  av1PublisherPercent: 40,
  av1ReceiverPercent: 60,
  av1BitrateFactor: 0.7,
  edgeShareKbps: 1300,
  youtubePercent: 10,

  simulivesPerMonth: 4,
  hoursPerSimulive: 1,
  viewersPerSimulive: 100,
  simuliveWatchPercent: 60,

  recordWebinarsPercent: 100,
  recordMeetingsPercent: 100,
  retentionDays: 30,
  keepLongerPercent: 20,
  keepLongerMonths: 3,
  recordingStore: "r2",
  replayHoursPerRecording: 30,
  recordingGbPerHour: 1.75,

  captionsPercent: 100,
  liveCaptionCores: 1,
  finalCaptionFactor: 0.75,
  finalCaptionCores: 2,
  captionsModelFactor: 0.6,

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
  qaSkipPercent: 50,

  emailsPerRegistrant: 4,
  emailsPerMeetingParticipant: 1,
  emailUsd: 0.0002,
  pushReplacePercent: 30,
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

  targetMarginPercent: 60,
  overheadInr: 300,
  planAttendeeCap: 300,
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
  /** Per coach a month. 0 on info lines; negative on savings (AV1, push). */
  usd: number;
  note: string;
  info?: boolean;
  /** The feature row it belongs to; none for fixed platform costs. */
  feature?: FeatureKey;
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
  /** Peak concurrency and the servers it needs, platform-wide. */
  servers: {
    peakSessions: number;
    peakEdgeWebinars: number;
    /** Always-on boxes, the first included (0 when the SFU is per session). */
    boxes: number;
    extraBoxes: number;
    extraRenderWorkers: number;
    extraRenderHours: number;
  };
  /** Recording storage held by the average coach, and the plan's quota. */
  storage: { heldGb: number; quotaGb: number; plan: string; overQuota: boolean };
  /** The recently shipped features' per-coach effect, for the side-by-side. */
  deltas: { shareUsd: number; turnUsd: number; av1Usd: number; edgeShareUsd: number; pushUsd: number; youtubeUsd: number };
  /** Revenue after GST and the payment fee, per coach a month. Null without a price. */
  netRevenueUsd: number | null;
  marginUsd: number | null;
  marginPercent: number | null;
};

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const pct = (n: number) => Math.min(100, nonNeg(n)) / 100;
const fmt = (n: number, digits = 0) => n.toLocaleString("en-IN", { maximumFractionDigits: digits });
const GIB = 1.073741824;
const DAYS_PER_MONTH = 365 / 12;

/** Merge saved or partial inputs over the defaults, provider by provider. Saved inputs from
 *  before the feature table (a `recording` or `ai` switch) carry over into `features`. */
export function withDefaults(saved: Partial<CostInputs> | null | undefined): CostInputs {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<CostInputs> & { recording?: boolean; ai?: boolean };
  const providers = { ...DEFAULT_PROVIDERS };
  for (const p of PROVIDERS) providers[p] = { ...DEFAULT_PROVIDERS[p], ...(s.providers?.[p] ?? {}) };
  // A calculation saved on Hetzner (deleted 2026-10-26) opens on the default provider.
  const provider = CALCULATOR_PROVIDERS.includes(s.provider as Provider)
    ? (s.provider as Provider)
    : DEFAULT_INPUTS.provider;
  const legacy: Partial<Record<FeatureKey, boolean>> = {};
  if (typeof s.recording === "boolean") legacy.recording = s.recording;
  if (typeof s.ai === "boolean") legacy.ai = s.ai;
  const features = { ...DEFAULT_FEATURES, ...legacy, ...(s.features ?? {}) };
  return { ...DEFAULT_INPUTS, ...s, provider, providers, features };
}

/** The blended screen-share bitrate a subscriber receives, Mbps: slides or video, VP9 or H264. */
export function shareMbps(i: CostInputs): number {
  const v = pct(i.shareVideoPercent);
  const h = pct(i.shareH264Percent);
  const slides = (1 - h) * nonNeg(i.shareSlidesVp9Mbps) + h * nonNeg(i.shareSlidesH264Mbps);
  const video = (1 - h) * nonNeg(i.shareVideoVp9Mbps) + h * nonNeg(i.shareVideoH264Mbps);
  return (1 - v) * slides + v * video;
}

/** The camera downlink AV1 saves, as a share of it: AV1 publishers × AV1 receivers × (1 − factor). */
export function av1Saving(i: CostInputs): number {
  if (!i.features?.av1) return 0;
  return pct(i.av1PublisherPercent) * pct(i.av1ReceiverPercent) * (1 - Math.min(1, nonNeg(i.av1BitrateFactor)));
}

/** The edge mix's average video bitrate: the 1080p share profile, when on, for the share's part. */
export function edgeVideoKbps(i: CostInputs): number {
  const base = nonNeg(i.edgeVideoKbps);
  if (!i.features?.edgeShare) return base;
  return base + pct(i.sharePercent) * Math.max(0, nonNeg(i.edgeShareKbps) - base);
}

/** What screen share, AV1 and TURN do to some SFU downlink, GB. `camGb` is the cameras'
 *  downlink, `shareReceiverHours` the hours somebody could be receiving a share, and
 *  `publisherHours` the hours somebody publishes (their uplink is relayed too). Also used by
 *  the Cost by host report (lib/host-costs.ts). */
export function sfuAdjust(
  i: CostInputs,
  a: { camGb: number; shareReceiverHours: number; publisherHours: number },
): { shareGb: number; av1Gb: number; turnGb: number } {
  const shareGb = nonNeg(a.shareReceiverHours) * pct(i.sharePercent) * shareMbps(i) * GB_PER_MBPS_HOUR;
  const av1Gb = -nonNeg(a.camGb) * av1Saving(i);
  const t = i.features?.turn ? pct(i.turnPercent) : 0;
  const turnGb = t * (nonNeg(a.camGb) + av1Gb + shareGb + nonNeg(a.publisherHours) * nonNeg(i.uplinkGbPerPublisherHour));
  return { shareGb, av1Gb, turnGb };
}

/** Peak concurrency from the coaches' hours spread over the busy hours, rounded up. */
export function peakConcurrent(platformHours: number, busyHours: number): number {
  const h = nonNeg(busyHours) || HOURS_PER_MONTH;
  return Math.max(0, Math.ceil(nonNeg(platformHours) / h - 1e-9));
}

/** Hours a month the video server box runs: 0 with no box, all month for an always-on one, and
 *  for an on-demand one the set boxHoursPerMonth, else the platform's session-hours plus
 *  boxOverheadMinutes per session (an upper bound: overlapping sessions share the overhead). */
export function boxRunHours(p: ProviderRates, platformSessionHours: number, platformSessions: number): number {
  if (!(nonNeg(p.boxMonthlyUsd) > 0)) return 0;
  if (!p.boxOnDemand) return HOURS_PER_MONTH;
  const set = nonNeg(p.boxHoursPerMonth);
  if (set > 0) return Math.min(HOURS_PER_MONTH, set);
  return Math.min(
    HOURS_PER_MONTH,
    nonNeg(platformSessionHours) + (nonNeg(platformSessions) * nonNeg(p.boxOverheadMinutes)) / 60,
  );
}

/** The plan the attendee cap stands for, and its recording quota in GB. */
export function quotaFor(cap: number): { plan: string; gb: number } {
  const q = RECORDING_QUOTAS.find((x) => x.cap === cap) ?? RECORDING_QUOTAS[3];
  return { plan: q.plan, gb: q.gib * GIB };
}

export function calculateCost(raw: CostInputs): CostResult {
  const i = withDefaults(raw);
  const f = i.features;
  const p = i.providers[i.provider];
  const coaches = Math.max(1, Math.round(nonNeg(i.coaches)));
  const warmup = nonNeg(i.warmupMinutes) / 60;
  const edge = i.delivery === "edge";
  const onServer = p.apiHost === "server";

  const webinars = f.webinars ? nonNeg(i.webinarsPerMonth) : 0;
  const hours = nonNeg(i.hoursPerWebinar);
  const liveHours = webinars * hours;
  const viewers = nonNeg(i.viewersPerWebinar);
  const viewerHours = liveHours * viewers * pct(i.watchPercent);
  const stage = Math.max(1, Math.round(nonNeg(i.onStage)));

  const meetings = f.meetings ? nonNeg(i.meetingsPerMonth) : 0;
  const participants = nonNeg(i.participantsPerMeeting);
  const meetingHours = meetings * nonNeg(i.hoursPerMeeting);
  const participantHours = meetingHours * participants;

  const simulives = f.simulive ? nonNeg(i.simulivesPerMonth) : 0;
  const simuliveViewerHours =
    simulives * nonNeg(i.hoursPerSimulive) * nonNeg(i.viewersPerSimulive) * pct(i.simuliveWatchPercent);

  const lines: CostLine[] = [];
  const add = (feature: FeatureKey | undefined, group: CostGroup, key: string, label: string, usd: number, note: string) => {
    if (usd > 0) lines.push({ key, group, label, usd, note, feature });
  };
  /** Savings are negative lines. */
  const save = (feature: FeatureKey, group: CostGroup, key: string, label: string, usd: number, note: string) => {
    if (usd < 0) lines.push({ key, group, label, usd, note, feature });
  };
  const info = (feature: FeatureKey | undefined, group: CostGroup, key: string, label: string, note: string) =>
    lines.push({ key, group, label, usd: 0, note, info: true, feature });

  // ---- Traffic, per coach, GB. All of it leaves the provider and meets the pool.
  const audioKbps = nonNeg(i.edgeAudioKbps);
  const baseGbPerViewerHour = edgeGbPerViewerHour(nonNeg(i.edgeVideoKbps), audioKbps);
  const gbPerViewerHour = edgeGbPerViewerHour(edgeVideoKbps(i), audioKbps);
  const shareProfileGbPerViewerHour = gbPerViewerHour - baseGbPerViewerHour;
  const [lo, hi] = stageMbps(stage);
  const stageGb = liveHours * ((lo + hi) / 2) * GB_PER_MBPS_HOUR;
  const originGb = edge ? liveHours * nonNeg(i.originPulls) * baseGbPerViewerHour : 0;
  const originShareGb = edge ? liveHours * nonNeg(i.originPulls) * shareProfileGbPerViewerHour : 0;
  const webrtcGb = edge ? 0 : viewerHours * nonNeg(i.webrtcViewerMbps) * GB_PER_MBPS_HOUR;
  const meetingGb = participantHours * nonNeg(i.meetingGbPerParticipantHour);
  const apiPerHour = nonNeg(i.apiMbPerViewerHour) / 1000;
  const apiWebinarGb = viewerHours * apiPerHour;
  const apiSimuliveGb = simuliveViewerHours * apiPerHour;
  const apiMeetingGb = participantHours * apiPerHour;
  const apiGb = apiWebinarGb + apiSimuliveGb + apiMeetingGb;

  // Screen share, AV1 and TURN on the SFU's downlink. The stage (and WebRTC viewers) receive
  // the share; edge viewers get it inside the mix.
  const webinarSfu = sfuAdjust(i, {
    camGb: stageGb + webrtcGb,
    shareReceiverHours: liveHours * (stage - 1) + (edge ? 0 : viewerHours),
    publisherHours: liveHours * stage,
  });
  const meetingSfu = sfuAdjust(i, {
    camGb: meetingGb,
    shareReceiverHours: participants > 0 ? participantHours * ((participants - 1) / participants) : 0,
    publisherHours: participantHours,
  });

  // ---- YouTube: the RTMP push rides the edge mix or the recording composite.
  const ytHours = f.youtube ? liveHours * pct(i.youtubePercent) : 0;
  const compositeGbPerHour = nonNeg(i.recordingGbPerHour);
  const youtubeGb = ytHours * (edge ? gbPerViewerHour : compositeGbPerHour);

  // ---- Recordings, per coach.
  const rec = f.recording;
  const recWebinarHours = rec ? liveHours * pct(i.recordWebinarsPercent) : 0;
  const recMeetingHours = rec ? meetingHours * pct(i.recordMeetingsPercent) : 0;
  const recWebinarCount = rec ? webinars * pct(i.recordWebinarsPercent) : 0;
  const recMeetingCount = rec ? meetings * pct(i.recordMeetingsPercent) : 0;
  // Edge records the running mix (#620): its size, no compute of its own.
  const webinarRecGbPerHour = edge ? gbPerViewerHour : compositeGbPerHour;
  const webinarRecGb = recWebinarHours * webinarRecGbPerHour;
  const meetingRecGb = recMeetingHours * compositeGbPerHour;
  const recordedGb = webinarRecGb + meetingRecGb;
  // Composite workers: every recorded meeting, and recorded webinars on standard delivery,
  // plus a standard-delivery YouTube stream that has no recording composite to ride.
  const compositeSessions = recMeetingCount + (edge ? 0 : recWebinarCount);
  const compositeHours = recMeetingHours + (edge ? 0 : recWebinarHours) + compositeSessions * warmup;
  const compositeWorkerHours = p.compositeOnBox ? 0 : compositeHours;
  const ytOwnHours = edge || p.compositeOnBox ? 0 : ytHours * (1 - (rec ? pct(i.recordWebinarsPercent) : 0));
  const ytWorkerHours = ytOwnHours > 0 ? ytOwnHours + (ytOwnHours / Math.max(hours, 1e-9)) * warmup : 0;

  // ---- Peak concurrency and servers, platform-wide. Every coach's session-hours spread over
  // the busy hours give the sessions live at once; a box carries `boxSessionCapacity`.
  const platformSessionHours = (liveHours + meetingHours) * coaches;
  const peakSessions = peakConcurrent(platformSessionHours, i.busyHoursPerMonth);
  const alwaysOn = nonNeg(p.boxMonthlyUsd) > 0;
  const boxes = alwaysOn ? Math.max(1, Math.ceil(peakSessions / Math.max(1, nonNeg(i.boxSessionCapacity)) - 1e-9)) : 0;
  const extraBoxes = Math.max(0, boxes - 1);
  // An on-demand box bills only the hours it runs (boxRunHours); its transfer allowance follows.
  const boxOnHours = boxRunHours(p, platformSessionHours, (webinars + meetings) * coaches);
  const boxShare = boxOnHours / HOURS_PER_MONTH;

  // ---- Render workers. Not co-located: one per live edge webinar. Co-located: each box
  // renders one mix at a time over the busy hours; the edge hours beyond that need workers.
  const edgeWorkerHoursPerCoach = edge && !p.workerColocated ? webinars * (hours + warmup) : 0;
  const platformEdgeHours = edge ? liveHours * coaches : 0;
  const peakEdgeWebinars = peakConcurrent(platformEdgeHours, i.busyHoursPerMonth);
  const colocated = edge && webinars > 0 && p.workerColocated;
  const boxRenderHours = Math.max(1, boxes) * (nonNeg(i.busyHoursPerMonth) || HOURS_PER_MONTH);
  const extraRenderHours = colocated ? Math.max(0, platformEdgeHours - boxRenderHours) : 0;
  const extraRenderWorkers = colocated ? Math.max(0, peakEdgeWebinars - Math.max(1, boxes)) : 0;
  const extraStarts = hours > 0 ? extraRenderHours / hours : 0;
  const extraRenderHoursPlatform = extraRenderHours + extraStarts * warmup;
  const workerHoursPlatform =
    (edgeWorkerHoursPerCoach + compositeWorkerHours + ytWorkerHours) * coaches + extraRenderHoursPlatform;

  // ---- The pool, platform-wide.
  const sfuExtraGb =
    webinarSfu.shareGb + webinarSfu.av1Gb + webinarSfu.turnGb + meetingSfu.shareGb + meetingSfu.av1Gb + meetingSfu.turnGb;
  const pooledGbPerCoach =
    stageGb + originGb + originShareGb + webrtcGb + meetingGb + recordedGb + youtubeGb + sfuExtraGb + (onServer ? apiGb : 0);
  const includedGb =
    (nonNeg(p.boxIncludedTb) * Math.max(1, boxes) * (alwaysOn ? boxShare : 1) +
      (onServer ? nonNeg(p.apiServerIncludedTb) : 0) +
      (nonNeg(p.workerIncludedTb) * workerHoursPlatform) / HOURS_PER_MONTH) *
    1000;
  const usedGb = Math.max(0, pooledGbPerCoach * coaches);
  const overageGb = Math.max(0, usedGb - includedGb);
  const overageUsd = overageGb * nonNeg(p.overagePerGb);
  // Shared back by GB: a coach's line is its GB at the pool's effective rate.
  const perGb = usedGb > 0 ? overageUsd / usedGb : 0;
  const poolNote = includedGb > 0 ? "beyond the pool" : `at $${nonNeg(p.overagePerGb).toFixed(3)}/GB`;
  const inPool = (gb: number) => (perGb === 0 && includedGb > 0 && gb !== 0 ? " (within the pool: $0)" : "");

  // ---- Delivery (webinars).
  if (edge) {
    add(
      "webinars",
      "delivery",
      "cdn",
      "CDN (Bunny)",
      viewerHours * baseGbPerViewerHour * nonNeg(i.cdnPerGb),
      `${fmt(viewerHours)} attendee-hours × ${baseGbPerViewerHour.toFixed(2)} GB`,
    );
    add(
      "webinars",
      "delivery",
      "origin",
      "Origin → CDN transfer",
      originGb * perGb,
      `${fmt(originGb, 1)} GB, ${fmt(nonNeg(i.originPulls))} CDN locations pull the stream, ${poolNote}`,
    );
    add(
      "webinars",
      "delivery",
      "worker",
      "Edge render worker",
      edgeWorkerHoursPerCoach * nonNeg(p.workerPerHour),
      "One per live edge webinar, plus its warm-up",
    );
    add(
      "edgeShare",
      "delivery",
      "edge-share-cdn",
      "1080p share profile: CDN",
      viewerHours * shareProfileGbPerViewerHour * nonNeg(i.cdnPerGb),
      `${nonNeg(i.edgeShareKbps)} kbps for ${fmt(pct(i.sharePercent) * 100)}% of the session: +${shareProfileGbPerViewerHour.toFixed(3)} GB per attendee-hour`,
    );
    add(
      "edgeShare",
      "delivery",
      "edge-share-origin",
      "1080p share profile: origin",
      originShareGb * perGb,
      `${fmt(originShareGb, 1)} GB more origin pulls, ${poolNote}`,
    );
    if (f.edgeShare && webinars > 0) {
      info(
        "edgeShare",
        "info",
        "edge-share-cpu",
        "1080p share profile: encode CPU",
        "1080p15 is ~1.7× the 720p20 pixel rate: ~1.2 cores average, ~2.9 peak on the box (docs/edge-delivery.md). The mix recording grows with it.",
      );
    }
  } else {
    add(
      "webinars",
      "delivery",
      "webrtc",
      "WebRTC viewers (SFU transfer)",
      webrtcGb * perGb,
      `${fmt(webrtcGb)} GB at ${nonNeg(i.webrtcViewerMbps)} Mbps, ${poolNote}`,
    );
  }
  add(
    "webinars",
    "delivery",
    "stage",
    "Stage traffic",
    stageGb * perGb,
    `${stage} on stage, ${fmt(stageGb, 1)} GB, ${poolNote}`,
  );
  add(
    "webinars",
    "delivery",
    "webinar-share",
    "Screen share (stage" + (edge ? ")" : " and WebRTC viewers)"),
    webinarSfu.shareGb * perGb,
    `${fmt(webinarSfu.shareGb, 1)} GB: one full layer at ${shareMbps(i).toFixed(2)} Mbps for ${fmt(pct(i.sharePercent) * 100)}% of the session, ${poolNote}`,
  );
  add(
    "webinars",
    "delivery",
    "sfu",
    "Video server (per webinar)",
    webinars * (hours + warmup) * nonNeg(p.sfuPerHour),
    "Started for each webinar and stopped after",
  );
  add(
    "webinars",
    "delivery",
    "api",
    onServer ? "API transfer (events, chat)" : "API egress from Cloud Run",
    onServer ? apiWebinarGb * perGb : apiWebinarGb * nonNeg(i.cloudRunEgressPerGb),
    `${fmt(apiWebinarGb, 1)} GB (${nonNeg(i.apiMbPerViewerHour)} MB per attendee-hour)`,
  );
  if (simulives > 0) {
    info(
      "simulive",
      "delivery",
      "simulive",
      "Simulive playback",
      `${fmt(simuliveViewerHours)} viewer-hours from R2 via the recordings domain (public bucket behind Cloudflare): $0 egress, no SFU. Only API traffic.`,
    );
  }
  add(
    "simulive",
    "delivery",
    "api-simulive",
    onServer ? "Simulive API transfer" : "Simulive API egress from Cloud Run",
    onServer ? apiSimuliveGb * perGb : apiSimuliveGb * nonNeg(i.cloudRunEgressPerGb),
    `${fmt(apiSimuliveGb, 1)} GB (${nonNeg(i.apiMbPerViewerHour)} MB per viewer-hour)`,
  );

  // ---- Meetings.
  const meetingNote = `${fmt(participantHours)} participant-hours × ${nonNeg(i.meetingGbPerParticipantHour)} GB = ${fmt(meetingGb)} GB, ${poolNote}; on GCP $${(meetingGb * GCP_EGRESS_PER_GB).toFixed(2)}`;
  if (meetingGb > 0 && meetingGb * perGb === 0) {
    info("meetings", "meetings", "meeting-transfer", "Meeting transfer (SFU downlink)", `Within the pool. ${meetingNote}`);
  }
  add("meetings", "meetings", "meeting-transfer", "Meeting transfer (SFU downlink)", meetingGb * perGb, meetingNote);
  add(
    "meetings",
    "meetings",
    "meeting-share",
    "Meeting screen share",
    meetingSfu.shareGb * perGb,
    `${fmt(meetingSfu.shareGb, 1)} GB: every other participant gets the full layer, ${poolNote}`,
  );
  add(
    "meetings",
    "meetings",
    "meeting-sfu",
    "Video server (per meeting)",
    meetings * (nonNeg(i.hoursPerMeeting) + warmup) * nonNeg(p.sfuPerHour),
    "Started for each meeting and stopped after",
  );
  add(
    "meetings",
    "meetings",
    "api-meetings",
    onServer ? "Meeting API transfer" : "Meeting API egress from Cloud Run",
    onServer ? apiMeetingGb * perGb : apiMeetingGb * nonNeg(i.cloudRunEgressPerGb),
    `${fmt(apiMeetingGb, 1)} GB (${nonNeg(i.apiMbPerViewerHour)} MB per participant-hour)`,
  );

  // ---- TURN and AV1, on meetings and the webinar stage.
  const turnGb = webinarSfu.turnGb + meetingSfu.turnGb;
  const av1Gb = webinarSfu.av1Gb + meetingSfu.av1Gb;
  const turnNote = (gb: number) =>
    `${fmt(pct(i.turnPercent) * 100)}% relayed, counted through the box once more (down and up): ${fmt(gb, 1)} GB, ${poolNote}`;
  add("turn", "delivery", "turn-webinars", "TURN relay: stage" + (edge ? "" : " and WebRTC viewers"), webinarSfu.turnGb * perGb, turnNote(webinarSfu.turnGb));
  add("turn", "meetings", "turn-meetings", "TURN relay: meetings", meetingSfu.turnGb * perGb, turnNote(meetingSfu.turnGb));
  if (f.turn && turnGb > 0) {
    info(
      "turn",
      "info",
      "turn-cpu",
      "TURN over TLS 443: CPU",
      `$0 cash. Caddy terminates TLS for the relayed ${fmt(pct(i.turnPercent) * 100)}% (${fmt(turnGb, 1)} GB a coach); a small share of a core at this volume.${inPool(turnGb)}`,
    );
  }
  const av1Note = (gb: number) =>
    `${fmt(-gb, 1)} GB less: ${fmt(pct(i.av1PublisherPercent) * 100)}% AV1 publishers × ${fmt(pct(i.av1ReceiverPercent) * 100)}% AV1 receivers × ${fmt((1 - Math.min(1, nonNeg(i.av1BitrateFactor))) * 100)}% smaller`;
  save("av1", "delivery", "av1-webinars", "AV1 saving: stage" + (edge ? "" : " and WebRTC viewers"), webinarSfu.av1Gb * perGb, av1Note(webinarSfu.av1Gb));
  save("av1", "meetings", "av1-meetings", "AV1 saving: meetings", meetingSfu.av1Gb * perGb, av1Note(meetingSfu.av1Gb));
  if (f.av1 && av1Gb < 0) {
    const pubHours = participantHours + liveHours * stage;
    const backupGb = pubHours * pct(i.av1PublisherPercent) * nonNeg(i.uplinkGbPerPublisherHour);
    info(
      "av1",
      "info",
      "av1-uplink",
      "AV1: backup codec, uplink and client CPU",
      `$0 to us. ${fmt(-av1Gb, 1)} GB less camera downlink a coach.${inPool(av1Gb)} AV1 publishers also send a VP8/H264 backup when a receiver needs it (≈ ${fmt(backupGb, 1)} GB more ingress, free on every provider) and encode twice on their own CPU.`,
    );
  }

  // ---- YouTube.
  add(
    "youtube",
    "delivery",
    "youtube",
    "YouTube RTMP push",
    youtubeGb * perGb,
    `${fmt(ytHours, 1)} streamed hours × ${(edge ? gbPerViewerHour : compositeGbPerHour).toFixed(2)} GB, ${poolNote}`,
  );
  add(
    "youtube",
    "delivery",
    "youtube-worker",
    "YouTube composite worker",
    ytWorkerHours * nonNeg(p.workerPerHour),
    `${fmt(ytWorkerHours, 1)} h for streams with no recording composite to ride`,
  );
  if (ytHours > 0 && youtubeGb * perGb === 0) {
    info("youtube", "delivery", "youtube-pool", "YouTube RTMP push", `${fmt(youtubeGb, 1)} GB within the pool; the push rides the ${edge ? "edge mix" : "recording composite"}.`);
  }

  // ---- Recording.
  const store = RECORDING_STORES[i.recordingStore] ?? RECORDING_STORES.r2;
  const quota = quotaFor(nonNeg(i.planAttendeeCap));
  // Steady state: each month's recordings are held for the retention, and Keep longer adds
  // months for some, but only within the plan's quota (over it, default retention only).
  const retentionMonths = nonNeg(i.retentionDays) / DAYS_PER_MONTH;
  const defaultHeldGb = recordedGb * retentionMonths;
  const keptGb = recordedGb * pct(i.keepLongerPercent) * nonNeg(i.keepLongerMonths);
  const heldGb = defaultHeldGb + Math.min(keptGb, Math.max(0, quota.gb - defaultHeldGb));
  if (rec) {
    add(
      "recording",
      "recording",
      "rec-worker",
      "Composite recording workers",
      compositeWorkerHours * nonNeg(p.workerPerHour),
      `${fmt(compositeHours, 1)} h for meetings${edge ? "" : " and standard-delivery webinars"}; edge recordings record the mix, no compute`,
    );
    add(
      "recording",
      "recording",
      "rec-upload",
      `Recording upload (→ ${store.label})`,
      recordedGb * perGb,
      `${fmt(recordedGb, 1)} GB a month leaves the video server once, ${poolNote}`,
    );
    add(
      "recording",
      "recording",
      "rec-storage",
      `Recording storage (${store.label})`,
      heldGb * store.perGbMonth,
      `${fmt(heldGb, 1)} GB held: ${fmt(nonNeg(i.retentionDays))} days, ${fmt(pct(i.keepLongerPercent) * 100)}% kept ${fmt(nonNeg(i.keepLongerMonths))} months longer within ${quota.plan}'s ${fmt(quota.gb, 0)} GB quota; webinars ${webinarRecGbPerHour.toFixed(2)} GB/h (${edge ? "mix" : "composite"}), meetings ${compositeGbPerHour} GB/h`,
    );
    add(
      "recording",
      "recording",
      "rec-replay",
      `Recording replay egress (${store.label})`,
      recWebinarCount * nonNeg(i.replayHoursPerRecording) * webinarRecGbPerHour * store.egressPerGb,
      `${fmt(recWebinarCount * nonNeg(i.replayHoursPerRecording))} replay hours a month`,
    );
  }

  // ---- Captions: capacity, not cash. English-only models run ~0.6× the multilingual CPU.
  const sessionHours = liveHours + meetingHours;
  const captionShare = f.captions ? pct(i.captionsPercent) : 0;
  const captionCoreHours =
    sessionHours *
    captionShare *
    (nonNeg(i.liveCaptionCores) + nonNeg(i.finalCaptionFactor) * nonNeg(i.finalCaptionCores)) *
    nonNeg(i.captionsModelFactor);
  const capacityCoreHours = alwaysOn ? nonNeg(p.boxCores) * boxOnHours * Math.max(1, boxes) : null;
  if (captionCoreHours > 0) {
    const platform = captionCoreHours * coaches;
    info(
      "captions",
      "info",
      "captions",
      "Captions (live + after-session run)",
      `$0 cash. ${fmt(captionCoreHours)} box CPU-hours a coach (English-only small.en/base.en, ${nonNeg(i.captionsModelFactor)}× multilingual), ${fmt(platform)} for ${coaches}` +
        (capacityCoreHours
          ? ` (${fmt((platform / capacityCoreHours) * 100)}% of the box's ${fmt(capacityCoreHours)} core-hours)`
          : "") +
        ". Replays and simulives reuse the VTT.",
    );
  }

  // ---- AI, capped per host. The Q&A confidence gate skips the model when retrieval finds nothing.
  const sessions = webinars + meetings + simulives;
  let aiUncappedUsd = 0;
  const aiCap = nonNeg(i.aiHostMonthlyUsd);
  if (f.ai) {
    const r = (inK: number, outK: number) => aiUsd(inK, outK, nonNeg(i.aiInPerM), nonNeg(i.aiOutPerM));
    const leads = webinars * nonNeg(i.leadsPerWebinar);
    const questions = (webinars + simulives) * nonNeg(i.questionsPerSession);
    const answered = 1 - pct(i.qaSkipPercent);
    const drafts = webinars * nonNeg(i.draftsPerSession) * answered;
    const autos = simulives * nonNeg(i.autoAnswersPerSimulive) * answered;
    const gate = `, ${fmt(pct(i.qaSkipPercent) * 100)}% skipped by the confidence gate`;
    const parts: [string, string, number, string][] = [
      ["ai-recap", "Recap and chapters", r(nonNeg(i.recapInKPerHour) * sessionHours, nonNeg(i.recapOutKPerHour) * sessionHours), `${fmt(sessionHours, 1)} session-hours`],
      ["ai-qa", "Q&A grouping", r(nonNeg(i.qaInK) * webinars, nonNeg(i.qaOutK) * webinars), `${fmt(webinars)} webinars`],
      ["ai-drafts", "Answer drafts", r(nonNeg(i.draftInK) * drafts, nonNeg(i.draftOutK) * drafts), `${fmt(drafts)} drafts${gate}`],
      ["ai-auto", "Auto mode answers (simulive)", r(nonNeg(i.draftInK) * autos, nonNeg(i.draftOutK) * autos), `${fmt(autos)} answers${gate}`],
      ["ai-leads", "Hot leads", r(nonNeg(i.leadsInK) * webinars, nonNeg(i.leadsOutK) * webinars), `${fmt(webinars)} webinars`],
      ["ai-followup", "Follow-up writer", r(nonNeg(i.followupInK) * leads, nonNeg(i.followupOutK) * leads), `${fmt(leads)} leads`],
      ["ai-harvest", "Past-answer harvest", r(nonNeg(i.harvestInK) * webinars, nonNeg(i.harvestOutK) * webinars), `${fmt(webinars)} webinars`],
      ["ai-embed", "Knowledge embeddings", ((nonNeg(i.libraryWordsPerMonth) * 1.33 + questions * nonNeg(i.tokensPerQuestion)) * nonNeg(i.embedPerM)) / 1e6, `${fmt(nonNeg(i.libraryWordsPerMonth))} library words + ${fmt(questions)} questions (all embedded for retrieval)`],
    ];
    aiUncappedUsd = parts.reduce((t, x) => t + x[2], 0);
    const scale = aiCap > 0 && aiUncappedUsd > aiCap ? aiCap / aiUncappedUsd : 1;
    for (const [key, label, usd, note] of parts) {
      add("ai", "ai", key, label, usd * scale, scale < 1 ? `${note}; capped at $${aiCap}/host` : note);
    }
  }
  const aiCapped = aiCap > 0 && aiUncappedUsd > aiCap;

  // ---- Messaging. Push replaces some reminders (every registrant email but the confirmation).
  const registrants = webinars * viewers;
  const emails = f.messaging
    ? registrants * nonNeg(i.emailsPerRegistrant) + meetings * participants * nonNeg(i.emailsPerMeetingParticipant)
    : 0;
  add("messaging", "messaging", "email", "Emails", emails * nonNeg(i.emailUsd), `${fmt(emails)} emails × $${nonNeg(i.emailUsd)}`);
  const pushed = f.messaging && f.push ? registrants * Math.max(0, nonNeg(i.emailsPerRegistrant) - 1) * pct(i.pushReplacePercent) : 0;
  save(
    "push",
    "messaging",
    "push",
    "Web push instead of reminder emails",
    -pushed * nonNeg(i.emailUsd),
    `${fmt(pushed)} reminders sent as push (${fmt(pct(i.pushReplacePercent) * 100)}% of reminders): browser push services are free`,
  );
  if (f.push) info("push", "info", "push-info", "Web push", "$0: browser vendors' push services (FCM, Mozilla, Apple) are free; the API sends them.");
  if (f.messaging) {
    const waInr =
      registrants * (nonNeg(i.waMarketingPerRegistrant) * nonNeg(i.waMarketingInr) + nonNeg(i.waUtilityPerRegistrant) * nonNeg(i.waUtilityInr));
    info(
      "messaging",
      "info",
      "whatsapp",
      "WhatsApp",
      `Billed to the coach's WABA, not us: ₹${nonNeg(i.waMarketingInr)} marketing, ₹${nonNeg(i.waUtilityInr)} utility, service replies free. ≈ ₹${fmt(waInr)} a month to the coach.`,
    );
  }

  // ---- Fixed and shared, spread over the coaches.
  const share = (usd: number) => usd / coaches;
  const fixed = (key: string, label: string, usd: number, note?: string) =>
    add(undefined, "fixed", key, label, share(nonNeg(usd)), note ?? `$${nonNeg(usd).toFixed(2)} a month over ${coaches} coaches`);
  const boxUsd = nonNeg(p.boxMonthlyUsd) * (alwaysOn ? boxShare : 1);
  fixed(
    "box",
    `Video server box (${p.label})`,
    boxUsd,
    alwaysOn && p.boxOnDemand
      ? `On demand: ${fmt(boxOnHours)} h a month ${nonNeg(p.boxHoursPerMonth) > 0 ? "(set)" : `(session hours + ${fmt(nonNeg(p.boxOverheadMinutes))} min warm-up and idle grace each)`} × $${(nonNeg(p.boxMonthlyUsd) / HOURS_PER_MONTH).toFixed(3)}/h = $${boxUsd.toFixed(2)}, over ${coaches} coaches`
      : undefined,
  );
  fixed(
    "extra-boxes",
    `Extra video server boxes (${extraBoxes})`,
    extraBoxes * boxUsd,
    `Peak ≈ ${peakSessions} sessions at once (${fmt(platformSessionHours)} session-hours over ${fmt(nonNeg(i.busyHoursPerMonth))} busy hours), ${fmt(nonNeg(i.boxSessionCapacity))} a box: ${extraBoxes} × $${boxUsd.toFixed(2)} over ${coaches} coaches`,
  );
  add(
    undefined,
    "fixed",
    "render-extra",
    "Extra render workers (concurrency)",
    (extraRenderHoursPlatform * nonNeg(p.workerPerHour)) / coaches,
    `Peak ≈ ${peakEdgeWebinars} edge webinars at once; each box renders one. ${fmt(extraRenderHours)} h a month beyond that (+ warm-up) × $${nonNeg(p.workerPerHour)}/h, over ${coaches} coaches`,
  );
  if (onServer) fixed("api-server", "API server", p.apiServerMonthlyUsd);
  else fixed("cloudrun", "Cloud Run (API compute, estimate)", i.cloudRunUsd);
  fixed("supabase", "Supabase", i.supabaseUsd);
  fixed("workers", "Cloudflare Workers", i.workersUsd);
  const cdnPlatform = lines.filter((l) => l.key === "cdn" || l.key === "edge-share-cdn").reduce((t, l) => t + l.usd, 0) * coaches;
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
  const sum = (...keys: string[]) => lines.filter((l) => keys.includes(l.key)).reduce((t, l) => t + l.usd, 0);
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
    servers: { peakSessions, peakEdgeWebinars, boxes, extraBoxes, extraRenderWorkers, extraRenderHours },
    storage: { heldGb: rec ? heldGb : 0, quotaGb: quota.gb, plan: quota.plan, overQuota: rec && defaultHeldGb > quota.gb },
    deltas: {
      shareUsd: sum("webinar-share", "meeting-share"),
      turnUsd: sum("turn-webinars", "turn-meetings"),
      av1Usd: sum("av1-webinars", "av1-meetings"),
      edgeShareUsd: sum("edge-share-cdn", "edge-share-origin"),
      pushUsd: sum("push"),
      youtubeUsd: sum("youtube", "youtube-worker"),
    },
    netRevenueUsd,
    marginUsd,
    marginPercent: netRevenueUsd && marginUsd != null ? (marginUsd / netRevenueUsd) * 100 : null,
  };
}

// ---------------------------------------------------------------- the feature table

export type FeatureRow = {
  key: FeatureKey;
  label: string;
  hint: string;
  on: boolean;
  /** Per coach a month (negative for a saving). */
  usd: number;
  /** Every coach together. */
  platformUsd: number;
  lines: CostLine[];
};

/** One row per feature: its lines summed, per coach and for every coach. */
export function featureRows(r: CostResult, features: Record<FeatureKey, boolean>): FeatureRow[] {
  return FEATURES.map(({ key, label, hint }) => {
    const lines = r.lines.filter((l) => l.feature === key);
    const usd = lines.reduce((t, l) => t + l.usd, 0);
    return { key, label, hint, on: !!features[key], usd, platformUsd: usd * r.coaches, lines };
  });
}

/** The fixed platform costs: per coach (their share) and for the platform. */
export function fixedRows(r: CostResult): { key: string; label: string; note: string; usd: number; platformUsd: number }[] {
  return r.lines
    .filter((l) => l.group === "fixed")
    .map((l) => ({ key: l.key, label: l.label, note: l.note, usd: l.usd, platformUsd: l.usd * r.coaches }));
}

/** Worst case: every coach fills their plan's recording quota. Per coach and platform, a month. */
export function quotaWorstCase(i: CostInputs): { plan: string; gb: number; usd: number; platformUsd: number }[] {
  const store = RECORDING_STORES[i.recordingStore] ?? RECORDING_STORES.r2;
  const coaches = Math.max(1, Math.round(nonNeg(i.coaches)));
  return RECORDING_QUOTAS.map((q) => {
    const gb = q.gib * GIB;
    return { plan: q.plan, gb, usd: gb * store.perGbMonth, platformUsd: gb * store.perGbMonth * coaches };
  });
}

/** The same inputs on every provider the calculator offers, for the side-by-side. */
export function compareProviders(inputs: CostInputs): Partial<Record<Provider, CostResult>> {
  return Object.fromEntries(
    CALCULATOR_PROVIDERS.map((p) => [p, calculateCost({ ...inputs, provider: p })]),
  ) as Partial<Record<Provider, CostResult>>;
}

// ---------------------------------------------------------------- minimum price

const GST = 0.18;

/** The price that leaves `costInr` after GST (when the price includes it), the payment fee
 *  and a gross margin of `marginPercent` on the net: cost ÷ (1 − margin) ÷ (1 − fee) × 1.18. */
export function grossUp(costInr: number, marginPercent: number, feePercent: number, includesGst: boolean): number {
  const margin = Math.min(99, nonNeg(marginPercent)) / 100;
  const fee = Math.min(99, nonNeg(feePercent)) / 100;
  return (nonNeg(costInr) / (1 - margin) / (1 - fee)) * (includesGst ? 1 + GST : 1);
}

/** Up to the next price ending in 99: 2,950 → 2,999, 2,999 → 2,999, 3,000 → 3,099. */
export function roundUpTo99(inr: number): number {
  if (!(inr > 0)) return 0;
  return Math.ceil((inr + 1) / 100) * 100 - 1;
}

export type Pricing = {
  /** The coach's cost a month (usage and share of fixed costs) plus overhead, in rupees. */
  costInr: number;
  breakEvenInr: number;
  minimumInr: number;
  /** Break-even at other coach counts, to show what scale does to the fixed costs. */
  breakEvenAt: { coaches: number; inr: number }[];
  /** Margin at the current price, overhead included. Null without a price. */
  currentMarginPercent: number | null;
  currentMarginInr: number | null;
  /** Attendees beyond the plan cap, and the per attendee-hour price that keeps the margin. */
  overage: { attendeeHours: number; perAttendeeHourInr: number; monthInr: number } | null;
};

export function calculatePricing(raw: CostInputs, scale: number[] = [1, 10, 50]): Pricing {
  const i = withDefaults(raw);
  const rate = nonNeg(i.inrPerUsd) || 1;
  const fee = nonNeg(i.paymentFeePercent);
  const costAt = (r: CostResult) => r.monthUsd * rate + nonNeg(i.overheadInr);
  const r = calculateCost(i);
  const costInr = costAt(r);
  const breakEvenInr = grossUp(costInr, 0, fee, i.priceIncludesGst);
  const minimumInr = roundUpTo99(grossUp(costInr, i.targetMarginPercent, fee, i.priceIncludesGst));
  const breakEvenAt = scale.map((coaches) => ({
    coaches,
    inr: grossUp(costAt(calculateCost({ ...i, coaches })), 0, fee, i.priceIncludesGst),
  }));

  let currentMarginInr: number | null = null;
  let currentMarginPercent: number | null = null;
  if (nonNeg(i.priceInr) > 0) {
    const net = (i.priceIncludesGst ? i.priceInr / (1 + GST) : i.priceInr) * (1 - Math.min(99, fee) / 100);
    currentMarginInr = net - costInr;
    currentMarginPercent = (currentMarginInr / net) * 100;
  }

  const cap = nonNeg(i.planAttendeeCap);
  const over = cap > 0 ? Math.max(0, nonNeg(i.viewersPerWebinar) - cap) : 0;
  let overage: Pricing["overage"] = null;
  if (over > 0) {
    const attendeeHours = over * nonNeg(i.webinarsPerMonth) * nonNeg(i.hoursPerWebinar) * pct(i.watchPercent);
    const perAttendeeHourInr = grossUp(r.perViewerHourUsd * rate, i.targetMarginPercent, fee, i.priceIncludesGst);
    overage = { attendeeHours, perAttendeeHourInr, monthInr: attendeeHours * perAttendeeHourInr };
  }

  return { costInr, breakEvenInr, minimumInr, breakEvenAt, currentMarginPercent, currentMarginInr, overage };
}
