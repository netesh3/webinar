/* What an admin setting costs US, per account, so whoever turns one on knows the bill it can
 * run up. Shown beside each setting on the admin Accounts screen.
 *
 * Estimates at list prices (2026-10): Bunny Standard network $0.01/GB (Europe, North
 * America) to $0.03/GB (Asia); GCP internet egress ~$0.12/GB; a c2d-highcpu-4 egress
 * worker ~$0.18/hour; B2 storage ~$0.006/GB-month; Hetzner includes ~20 TB/month of
 * traffic. Update the numbers here when a price changes — nothing else repeats them. */

import {
  FeatureCloudRecording,
  FeatureEdgeDelivery,
  FeatureInstantWebinar,
  FeatureJoinWithoutRegistration,
  FeatureWhatsAppCRM,
  FeatureWhiteboard,
  FeatureZoom,
} from "./api-types.ts";

const GCP_EGRESS_PER_GB = 0.12;
const GB_PER_MBPS_HOUR = 0.45; // 1 Mbps for an hour

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 1 : 0)}`;
}

/** Stage traffic out of the SFU for `n` people on stage: each receives the other n-1 at
 *  ~0.6–2 Mbps (360p–720p tiles), so it grows with the square of the stage. */
export function stageMbps(n: number): [number, number] {
  const pairs = Math.max(0, n * (n - 1));
  return [pairs * 0.6, pairs * 2];
}

/** One line on what a stage of `n` costs per live hour on a GCP-hosted video server. */
export function stageCostText(n: number): string {
  const [lo, hi] = stageMbps(n);
  const cost = (mbps: number) => mbps * GB_PER_MBPS_HOUR * GCP_EGRESS_PER_GB;
  if (n <= 1) return "1 person on stage: no stage-to-stage traffic.";
  return (
    `${n} on stage: ~${Math.round(lo)}–${Math.round(hi)} Mbps out of the video server, ` +
    `≈ ${usd(cost(lo))}–${usd(cost(hi))} per live hour on the Mumbai (GCP) server; ` +
    `included in Hetzner's traffic. Grows with the square of the stage.`
  );
}

export const COSTS = {
  canHost:
    "Every live hour uses the video server. On Hetzner the traffic is included (~20 TB/month); " +
    "on the Mumbai (GCP) server, standard delivery is ≈ $0.07–0.13 per attendee-hour.",
  maxDuration:
    "Longer sessions multiply every per-hour cost (video server traffic, Edge CDN, egress " +
    "workers, recording) for each webinar this host runs.",
  mediaQuota: "Object storage at ≈ $0.006 per GB per month — 1 GB is about a cent a month.",
  plan:
    "Sets the attendee and stage caps, so the worst-case hour: e.g. Enterprise, 500 attendees " +
    "on Edge ≈ $5.50–17/hour of CDN plus a 10-person stage (≈ $3–10/hour on GCP).",
  videoServer:
    "Hetzner (default): traffic included. Mumbai (GCP): stage traffic ≈ $0.12/GB and an Edge " +
    "egress worker ≈ $0.18/hour per live Edge webinar; lower latency for Indian audiences.",
} as const;

/** Cost lines for the features in the catalogue, by key. */
export const FEATURE_COSTS: Record<string, string> = {
  [FeatureEdgeDelivery]:
    "Bunny CDN ≈ $0.011 (Europe/US) to $0.034 (Asia) per attendee-hour at 2.5 Mbps, plus an " +
    "egress worker ≈ $0.18/hour per live webinar on a pooled server. 200 attendees in India " +
    "for an hour ≈ $7.",
  [FeatureCloudRecording]:
    "An encode while recording (a worker ≈ $0.18/hour on pooled servers) and ~1.5–2 GB stored " +
    "per recorded hour ≈ $0.01 per hour of recording per month.",
  [FeatureWhatsAppCRM]:
    "Messages are billed by Meta to the host's own WhatsApp Business account; to us, only the " +
    "media library's storage.",
  [FeatureZoom]: "Runs on the host's own Zoom account: no video cost to us.",
  [FeatureJoinWithoutRegistration]: "No direct cost; can bring more attendees into each live hour.",
  [FeatureInstantWebinar]: "No direct cost beyond the live hours it starts.",
  [FeatureWhiteboard]: "Negligible: it travels on the existing data channel.",
};
