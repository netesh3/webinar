/* What one coach costs us a month, from how they run their webinars. The admin Cost
 * calculator tab (components/admin-cost-calculator.tsx) is this function with inputs.
 *
 * Every price is an input with a default, because the defaults go stale and an admin
 * checking a quote should not need a deploy to try a new one. The defaults are list prices
 * as of 2026-10-21: Bunny Volume network $0.005/GB, GCP internet egress ~$0.12/GB, a
 * c2d-highcpu-2 egress worker ~$0.09/hour and an e2-standard-2 SFU ~$0.07/hour in Mumbai
 * (both only run while a webinar needs them). Recordings: Cloudflare R2 $0.015/GB-month with
 * free egress, or Backblaze B2 $0.006/GB-month and ~$0.01/GB downloaded; either way the
 * finished file leaves GCP over the internet once, at GCP's egress price. Hetzner's traffic
 * is included in the box and its composites run on it, so on Hetzner the stage, WebRTC and
 * worker lines are the box's fixed cost, not this coach's.
 *
 * Cloud Run (the API: 1 vCPU, 1 GiB, request-based billing, 500 requests per instance) is
 * $0.000024 per vCPU-second plus $0.0000025 per GiB-second while any request is open, about
 * $0.095 an instance-hour, and $0.40 per million requests. An edge viewer's event stream is a
 * request open for the whole webinar, so an edge webinar keeps ceil(viewers / 500) instances
 * billed for its length. That is pessimistic when two coaches are live at once (they share an
 * instance) and the free tier is ignored. The database (Supabase) and the Hetzner box are
 * fixed monthly costs, divided by the number of coaches sharing them.
 *
 * Pure: no React, no DOM, so it runs under node tests. */

import { GB_PER_MBPS_HOUR, GCP_EGRESS_PER_GB, stageMbps } from "./admin-costs.ts";

export type Delivery = "edge" | "webrtc";
export type VideoServer = "gcp" | "hetzner";
export type RecordingStore = "r2" | "b2";

/** Per GB stored a month, and per GB downloaded (R2 has no egress fee). */
export const RECORDING_STORES: Record<RecordingStore, { label: string; perGbMonth: number; egressPerGb: number }> = {
  r2: { label: "Cloudflare R2", perGbMonth: 0.015, egressPerGb: 0 },
  b2: { label: "Backblaze B2", perGbMonth: 0.006, egressPerGb: 0.01 },
};

export type CostInputs = {
  webinarsPerMonth: number;
  hoursPerWebinar: number;
  viewersPerWebinar: number;
  /** Share of the session the average viewer watches, 0–100. */
  watchPercent: number;
  /** Everyone on the stage, the host included. */
  onStage: number;
  delivery: Delivery;
  videoServer: VideoServer;
  recording: boolean;
  /** Months a recording is kept. */
  recordingMonths: number;
  recordingStore: RecordingStore;
  /** Hours of each recording people watch back, all viewers together. */
  replayHoursPerRecording: number;

  edgeVideoKbps: number;
  edgeAudioKbps: number;
  cdnPerGb: number;
  /** How many CDN edge locations pull each segment from the origin. */
  originPulls: number;
  egressPerGb: number;
  workerPerHour: number;
  sfuPerHour: number;
  /** Minutes a worker or SFU runs around each webinar: boot before, drain after. */
  warmupMinutes: number;
  /** What one WebRTC viewer pulls from the SFU (a 720p stage plus audio). */
  webrtcViewerMbps: number;
  /** What the API sends each viewer an hour: the event stream, chat, Q&A, attendance beats. */
  apiMbPerViewerHour: number;
  cloudRunPerInstanceHour: number;
  /** Requests one Cloud Run instance holds at once (deploy: --concurrency). */
  cloudRunConcurrency: number;
  /** API calls a viewer makes an hour: attendance beats (120), chat, Q&A, polls. */
  requestsPerViewerHour: number;
  perMillionRequests: number;
  /** The database's monthly bill (Supabase plan plus compute), for the whole instance. */
  dbMonthlyUsd: number;
  /** The Hetzner box's monthly bill, for everybody on it. */
  hetznerMonthlyUsd: number;
  /** Coaches the fixed bills (database, Hetzner box) are split between. */
  coachesSharing: number;
  /** Stored size of a recorded hour. */
  recordingGbPerHour: number;

  inrPerUsd: number;
  /** What the coach pays a month, in rupees. 0 skips the margin. */
  priceInr: number;
  priceIncludesGst: boolean;
  paymentFeePercent: number;
};

export const DEFAULT_INPUTS: CostInputs = {
  webinarsPerMonth: 4,
  hoursPerWebinar: 1.5,
  viewersPerWebinar: 300,
  watchPercent: 70,
  onStage: 2,
  delivery: "edge",
  videoServer: "gcp",
  recording: true,
  recordingMonths: 3,
  recordingStore: "r2",
  replayHoursPerRecording: 30,

  edgeVideoKbps: 1000,
  edgeAudioKbps: 96,
  cdnPerGb: 0.005,
  originPulls: 3,
  egressPerGb: GCP_EGRESS_PER_GB,
  workerPerHour: 0.09,
  sfuPerHour: 0.07,
  warmupMinutes: 10,
  webrtcViewerMbps: 1.5,
  apiMbPerViewerHour: 3,
  cloudRunPerInstanceHour: 0.0954,
  cloudRunConcurrency: 500,
  requestsPerViewerHour: 150,
  perMillionRequests: 0.4,
  dbMonthlyUsd: 25,
  hetznerMonthlyUsd: 11,
  coachesSharing: 20,
  recordingGbPerHour: 1.75,

  inrPerUsd: 100,
  priceInr: 4999,
  priceIncludesGst: true,
  paymentFeePercent: 2,
};

/** HLS segments and HTTP add about 6% to the encoded bitrate. */
const HLS_OVERHEAD = 1.06;

/** GB one edge viewer downloads in an hour at the mix's bitrate. */
export function edgeGbPerViewerHour(videoKbps: number, audioKbps: number): number {
  return ((videoKbps + audioKbps) * HLS_OVERHEAD * 3600) / 8 / 1e6;
}

export type CostLine = { key: string; label: string; usd: number; note: string };

export type CostResult = {
  lines: CostLine[];
  /** Per month, every line. */
  monthUsd: number;
  webinarUsd: number;
  viewerHours: number;
  perViewerHourUsd: number;
  /** Revenue after GST and the payment fee, per month. Null without a price. */
  netRevenueUsd: number | null;
  marginUsd: number | null;
  marginPercent: number | null;
};

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function calculateCost(raw: CostInputs): CostResult {
  const i = { ...raw };
  const webinars = nonNeg(i.webinarsPerMonth);
  const hours = nonNeg(i.hoursPerWebinar);
  const viewers = nonNeg(i.viewersPerWebinar);
  const watch = Math.min(100, nonNeg(i.watchPercent)) / 100;
  const stage = Math.max(1, Math.round(nonNeg(i.onStage)));
  const gcp = i.videoServer === "gcp";
  const edge = i.delivery === "edge";
  const warmup = nonNeg(i.warmupMinutes) / 60;

  const liveHours = webinars * hours;
  const viewerHours = liveHours * viewers * watch;
  const lines: CostLine[] = [];
  const add = (key: string, label: string, usd: number, note: string) => {
    if (usd > 0) lines.push({ key, label, usd, note });
  };

  if (edge) {
    const gbPerHour = edgeGbPerViewerHour(nonNeg(i.edgeVideoKbps), nonNeg(i.edgeAudioKbps));
    add(
      "cdn",
      "CDN (Bunny)",
      viewerHours * gbPerHour * nonNeg(i.cdnPerGb),
      `${Math.round(viewerHours).toLocaleString("en-IN")} viewer-hours × ${gbPerHour.toFixed(2)} GB`,
    );
    if (gcp) {
      add(
        "worker",
        "Edge egress worker",
        webinars * (hours + warmup) * nonNeg(i.workerPerHour),
        "One worker per live edge webinar, plus its warm-up",
      );
      add(
        "origin",
        "Origin → CDN egress",
        liveHours * nonNeg(i.originPulls) * gbPerHour * nonNeg(i.egressPerGb),
        `Each of ${nonNeg(i.originPulls)} CDN locations pulls the stream once`,
      );
    }
  } else if (gcp) {
    add(
      "webrtc",
      "WebRTC viewers (SFU egress)",
      viewerHours * nonNeg(i.webrtcViewerMbps) * GB_PER_MBPS_HOUR * nonNeg(i.egressPerGb),
      `${Math.round(viewerHours).toLocaleString("en-IN")} viewer-hours × ${nonNeg(i.webrtcViewerMbps)} Mbps`,
    );
  }

  if (gcp) {
    const [lo, hi] = stageMbps(stage);
    add(
      "stage",
      "Stage traffic",
      liveHours * ((lo + hi) / 2) * GB_PER_MBPS_HOUR * nonNeg(i.egressPerGb),
      `${stage} on stage, each receiving the other ${stage - 1}`,
    );
    add(
      "sfu",
      "Video server (SFU)",
      webinars * (hours + warmup) * nonNeg(i.sfuPerHour),
      "Started for each webinar and stopped after",
    );
  }

  // The API is on Cloud Run whatever the video server: every viewer's events leave GCP.
  add(
    "api",
    "API egress (events, chat)",
    (viewerHours * nonNeg(i.apiMbPerViewerHour) * nonNeg(i.egressPerGb)) / 1000,
    `${nonNeg(i.apiMbPerViewerHour)} MB per viewer-hour from Cloud Run`,
  );

  // Edge viewers hold a stream open, so instances are billed for the webinar; WebRTC
  // viewers only make short calls, which the request count covers.
  const instances = edge ? Math.max(1, Math.ceil(viewers / (nonNeg(i.cloudRunConcurrency) || 500))) : 0;
  const requests = viewerHours * nonNeg(i.requestsPerViewerHour);
  add(
    "cloudrun",
    "Cloud Run compute (API)",
    liveHours * instances * nonNeg(i.cloudRunPerInstanceHour) + (requests / 1e6) * nonNeg(i.perMillionRequests),
    edge
      ? `${instances} instance${instances === 1 ? "" : "s"} for ${liveHours} live hours, ${Math.round(requests).toLocaleString("en-IN")} requests`
      : `${Math.round(requests).toLocaleString("en-IN")} requests`,
  );

  const coaches = Math.max(1, Math.round(nonNeg(i.coachesSharing)));
  add(
    "db",
    "Database (share)",
    nonNeg(i.dbMonthlyUsd) / coaches,
    `$${nonNeg(i.dbMonthlyUsd)} a month split between ${coaches} coaches`,
  );
  if (!gcp) {
    add(
      "hetzner",
      "Hetzner box (share)",
      nonNeg(i.hetznerMonthlyUsd) / coaches,
      `$${nonNeg(i.hetznerMonthlyUsd)} a month split between ${coaches} coaches`,
    );
  }

  if (i.recording) {
    const store = RECORDING_STORES[i.recordingStore] ?? RECORDING_STORES.r2;
    const recordedGb = liveHours * nonNeg(i.recordingGbPerHour);
    if (gcp) {
      add(
        "rec-worker",
        "Recording encode",
        webinars * (hours + warmup) * nonNeg(i.workerPerHour),
        "A composite worker for each recorded webinar",
      );
      add(
        "rec-upload",
        `Recording upload egress (GCP → ${store.label})`,
        recordedGb * nonNeg(i.egressPerGb),
        `${recordedGb.toFixed(1)} GB a month leaves GCP once`,
      );
    }
    // Steady state: every month adds this much, and each month's is kept for N months.
    add(
      "rec-storage",
      `Recording storage (${store.label})`,
      recordedGb * nonNeg(i.recordingMonths) * store.perGbMonth,
      `${(recordedGb * nonNeg(i.recordingMonths)).toFixed(1)} GB held (${nonNeg(i.recordingGbPerHour)} GB/hour, kept ${nonNeg(i.recordingMonths)} months)`,
    );
    add(
      "rec-replay",
      `Recording replay egress (${store.label})`,
      webinars * nonNeg(i.replayHoursPerRecording) * nonNeg(i.recordingGbPerHour) * store.egressPerGb,
      `${webinars * nonNeg(i.replayHoursPerRecording)} replay hours a month`,
    );
  }

  const monthUsd = lines.reduce((t, l) => t + l.usd, 0);
  const rate = nonNeg(i.inrPerUsd) || 1;
  let netRevenueUsd: number | null = null;
  if (nonNeg(i.priceInr) > 0) {
    const exGst = i.priceIncludesGst ? i.priceInr / 1.18 : i.priceInr;
    netRevenueUsd = (exGst * (1 - Math.min(100, nonNeg(i.paymentFeePercent)) / 100)) / rate;
  }
  const marginUsd = netRevenueUsd == null ? null : netRevenueUsd - monthUsd;
  return {
    lines,
    monthUsd,
    webinarUsd: webinars > 0 ? monthUsd / webinars : 0,
    viewerHours,
    perViewerHourUsd: viewerHours > 0 ? monthUsd / viewerHours : 0,
    netRevenueUsd,
    marginUsd,
    marginPercent:
      netRevenueUsd && marginUsd != null ? (marginUsd / netRevenueUsd) * 100 : null,
  };
}
