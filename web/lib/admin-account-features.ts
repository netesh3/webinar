import type { Feature, FeatureGrant, FeatureGroup, PlanFeatures } from "./api-types.ts";

/* Which switches an admin sees under Features on an account row.
 *
 * The catalogue is the server's list, in the server's order — WhatsApp CRM,
 * Cloud recording, Join without registration, Instant webinar, Zoom. Instant
 * webinar used to be a separate switch in the row header; it belongs here, in
 * that slot, and only for an account that can host. The other catalogue
 * switches were already host-only, for the same reason: they act on a webinar
 * this account would create.
 *
 * (CDN Broadcast used to follow the catalogue as its own row; that mode was retired in
 * 2026-10, Edge delivery being the big-audience path.)
 */

export type AccountFeatureRow = {
  /* Catalogue feature key, sent to PATCH …/features. */
  id: string;
  source: "feature";
  label: string;
  description: string;
  /* The FeatureGroup heading it is filed under. */
  group: string;
  /* The switches it needs to be in effect (Feature.requires). */
  requires: string[];
  /* No plan includes it: off by default for every host, on only by this override (every AI
   * switch, Feature.perHost). */
  perHost: boolean;
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
        group: f.group,
        requires: f.requires ?? [],
        perHost: f.perHost ?? false,
      }))
    : [];
  return features;
}

/* How many of the visible rows are on. A feature key that is not in the list
 * — Instant webinar on an account that cannot host, for example — does not
 * count, because that switch is not shown. */
export function accountFeaturesOnCount(
  rows: readonly AccountFeatureRow[],
  features: readonly string[] | null | undefined,
): number {
  const on = new Set(features ?? []);
  return rows.filter((row) => on.has(row.id)).length;
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

/* The Inherit option's label: what the plan gives. A per-host switch (every AI one) is off on
 * every plan, so it says so rather than waiting on the matrix. */
export function inheritLabel(inherited: boolean | null, perHost: boolean): string {
  if (perHost) return "Plan default (off: per host only)";
  return inherited === null ? "Plan default" : `Plan default (${inherited ? "on" : "off"})`;
}

/* The plan matrix as saved: a per-host switch is never in a tier (the server refuses it, 422
 * per_host_feature), so one left in a draft from an older matrix is dropped. */
export function tierFeaturesToSave(
  draft: Iterable<string>,
  catalogue: readonly Feature[],
): string[] {
  const perHost = new Set(catalogue.filter((f) => f.perHost).map((f) => f.key));
  return [...draft].filter((k) => !perHost.has(k));
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

/* The rows under their group headings, in the server's group order; a row whose group the
 * server did not list goes under "Other" at the end, so nothing is ever hidden. Empty groups
 * are left out. */
export type AccountFeatureGroup = { key: string; label: string; rows: AccountFeatureRow[] };

export function groupFeatureRows(
  rows: readonly AccountFeatureRow[],
  groups: readonly FeatureGroup[] | null | undefined,
): AccountFeatureGroup[] {
  const known = groups ?? [];
  const out: AccountFeatureGroup[] = known.map((g) => ({ key: g.key, label: g.label, rows: [] }));
  const other: AccountFeatureGroup = { key: "other", label: "Other", rows: [] };
  for (const row of rows) {
    (out.find((g) => g.key === row.group) ?? other).rows.push(row);
  }
  return [...out, other].filter((g) => g.rows.length > 0);
}

/* The labels of the switches a row needs that are not in effect for this account, e.g.
 * ["AI writing"] for AI knowledge on an account without AI. Empty when nothing is missing.
 * The server already leaves such a row out of `features`; this says why. */
export function unmetRequirements(
  row: Pick<AccountFeatureRow, "requires">,
  features: readonly string[] | null | undefined,
  catalogue: readonly Feature[],
): string[] {
  const on = new Set(features ?? []);
  return row.requires
    .filter((key) => !on.has(key))
    .map((key) => catalogue.find((f) => f.key === key)?.label ?? key);
}

/* The one request that sets every row of a group to the same state (PUT …/features). */
export function bulkGrants(rows: readonly AccountFeatureRow[], state: OverrideState): FeatureGrant[] {
  return rows.map((row) =>
    state === "inherit"
      ? { feature: row.id, enabled: false, inherit: true }
      : { feature: row.id, enabled: state === "on" },
  );
}

// The override map after a bulk change, matching what the server now stores.
export function withOverrides(
  overrides: Record<string, boolean> | null | undefined,
  keys: readonly string[],
  state: OverrideState,
): Record<string, boolean> {
  let next = { ...(overrides ?? {}) };
  for (const key of keys) next = withOverride(next, key, state);
  return next;
}
