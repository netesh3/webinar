import type { Feature, PlanFeatures } from "./api-types.ts";

/* Which switches an admin sees under Features on an account row.
 *
 * The catalogue is the server's list, in the server's order — WhatsApp CRM,
 * Cloud recording, Join without registration, Instant webinar, Zoom. Instant
 * webinar used to be a separate switch in the row header; it belongs here, in
 * that slot, and only for an account that can host. The other catalogue
 * switches were already host-only, for the same reason: they act on a webinar
 * this account would create.
 *
 * CDN Broadcast is not a catalogue key. It stays the boolean canCdnBroadcast,
 * patched at /api/admin/users/{id}/cdn-broadcast, and it is offered on every
 * account, including one that cannot host yet. It follows the catalogue so
 * the server's order is left as the server declared it.
 */

export const CDN_BROADCAST_ROW_ID = "cdn_broadcast";

const CDN_BROADCAST_DESCRIPTION =
  "Let this host's webinars stream the audience over HLS. Off means attendees stay in the live room.";

export type AccountFeatureRow = {
  /* Catalogue feature key, or CDN_BROADCAST_ROW_ID. Only source "feature" is
   * sent to PATCH …/features. The CDN row uses PATCH …/cdn-broadcast. */
  id: string;
  source: "feature" | "cdn_broadcast";
  label: string;
  description: string;
};

export function accountFeatureRows(
  canHost: boolean,
  catalogue: readonly Feature[],
): AccountFeatureRow[] {
  const features: AccountFeatureRow[] = canHost
    ? catalogue.map((f) => ({
        id: f.key,
        source: "feature",
        label: f.label,
        description: f.description,
      }))
    : [];
  return [
    ...features,
    {
      id: CDN_BROADCAST_ROW_ID,
      source: "cdn_broadcast",
      label: "CDN Broadcast",
      description: CDN_BROADCAST_DESCRIPTION,
    },
  ];
}

/* How many of the visible rows are on. A feature key that is not in the list
 * — Instant webinar on an account that cannot host, for example — does not
 * count, because that switch is not shown. */
export function accountFeaturesOnCount(
  rows: readonly AccountFeatureRow[],
  features: readonly string[] | null | undefined,
  canCdnBroadcast: boolean,
): number {
  const on = new Set(features ?? []);
  let n = 0;
  for (const row of rows) {
    if (row.source === "cdn_broadcast") {
      if (canCdnBroadcast) n += 1;
    } else if (on.has(row.id)) {
      n += 1;
    }
  }
  return n;
}

/* Plan, then overrides (migrations/0107). The admin row shows each catalogue
 * feature as Inherit / On / Off; Inherit is labelled with what the plan gives. */
export type OverrideState = "inherit" | "on" | "off";

export function overrideState(
  overrides: Record<string, boolean> | null | undefined,
  key: string,
): OverrideState {
  if (!overrides || !(key in overrides)) return "inherit";
  return overrides[key] ? "on" : "off";
}

// Whether the account's plan includes this feature; null while the matrix loads.
export function planIncludes(
  tiers: readonly PlanFeatures[] | null,
  plan: string | null | undefined,
  key: string,
): boolean | null {
  if (!tiers) return null;
  const tier = tiers.find((t) => t.plan === (plan ?? ""));
  return tier ? tier.features.includes(key) : false;
}

// The override map after one change, matching what the server now stores.
export function withOverride(
  overrides: Record<string, boolean> | null | undefined,
  key: string,
  state: OverrideState,
): Record<string, boolean> {
  const next = { ...(overrides ?? {}) };
  if (state === "inherit") delete next[key];
  else next[key] = state === "on";
  return next;
}
