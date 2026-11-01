/* Stage traffic and egress prices shared by the admin cost calculator and "Cost by host"
 * (lib/cost-calculator.ts, lib/host-costs.ts).
 *
 * (2 Nov 2026) The per-account "Cost of these settings" texts that used to live here went with
 * the Accounts tab redesign; only the numbers the two calculators read are left.
 *
 * Estimates at list prices (2026-10): GCP internet egress ~$0.12/GB. Update the numbers here
 * when a price changes — nothing else repeats them. */

export const GCP_EGRESS_PER_GB = 0.12;
export const GB_PER_MBPS_HOUR = 0.45; // 1 Mbps for an hour

/** Stage traffic out of the SFU for `n` people on stage: each receives the other n-1 at
 *  ~0.6–2 Mbps (360p–720p tiles), so it grows with the square of the stage. */
export function stageMbps(n: number): [number, number] {
  const pairs = Math.max(0, n * (n - 1));
  return [pairs * 0.6, pairs * 2];
}
