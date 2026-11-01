/* The Admin → Accounts switches, grouped and named the way the pricing page sells them
 * (2 Nov 2026). One map, next to lib/plans.ts: every types.Features key sits in exactly one group
 * (admin-feature-groups.test.mts checks it), the groups follow the "Compare all features"
 * sections, and the labels are the customer-facing names. The server still owns each switch's
 * description (config.featureCatalogue). Per-host switches, which no plan sells, are in their
 * own "Admin only" group.
 *
 * Pure, so it runs under node tests. */

import type { AdminUser, Feature, PlanFeatures } from "./api-types.ts";
import { COMPARISON } from "./plans.ts";

export type AdminFeatureGroupDef = {
  /** The comparison section's id (lib/plans.ts COMPARISON), or "admin" for Admin only. */
  id: string;
  title: string;
  /** The switches in it, in order, with the name a customer sees. */
  features: { key: string; label: string }[];
};

const sectionTitle = (id: string): string => COMPARISON.find((g) => g.id === id)?.title ?? id;

export const ADMIN_FEATURE_GROUPS: AdminFeatureGroupDef[] = [
  {
    id: "live",
    title: sectionTitle("live"),
    features: [
      { key: "meetings", label: "Meetings with a lobby" },
      { key: "whiteboard", label: "Whiteboard" },
      { key: "simulive", label: "Simulive" },
      { key: "replay_engage", label: "Simulive engagement replay" },
      { key: "join_without_registration", label: "Join without registration (paused)" },
    ],
  },
  {
    id: "reminders",
    title: sectionTitle("reminders"),
    features: [
      { key: "whatsapp_crm", label: "WhatsApp reminders, campaigns and automations" },
      { key: "followup_send", label: "AI follow-up drafts by engagement" },
    ],
  },
  {
    id: "recording",
    title: sectionTitle("recording"),
    features: [{ key: "cloud_recording", label: "Cloud recording" }],
  },
  {
    id: "streaming",
    title: sectionTitle("streaming"),
    features: [{ key: "stream_out", label: "Stream to YouTube, LinkedIn, Facebook and Instagram" }],
  },
  {
    id: "ai",
    title: sectionTitle("ai"),
    features: [
      { key: "ai", label: "AI recap, answer drafts, Write with AI and the spam filter" },
      { key: "ai_knowledge", label: "AI knowledge base" },
      { key: "simulive_auto", label: "Simulive auto mode" },
      { key: "repurpose", label: "AI Blog, newsletter and social drafts" },
      { key: "captions", label: "AI Live captions" },
    ],
  },
  {
    id: "integrations",
    title: sectionTitle("integrations"),
    features: [
      { key: "zoom", label: "Zoom" },
      { key: "google_drive", label: "Google Drive" },
    ],
  },
  {
    id: "analytics",
    title: sectionTitle("analytics"),
    features: [
      { key: "audience_insights", label: "Audience device & location insights" },
      { key: "csv_export", label: "CSV exports" },
    ],
  },
  {
    id: "admin",
    title: "Admin only",
    features: [
      { key: "clips", label: "Highlight clips and reels" },
      { key: "instant_webinar", label: "Instant meetings and webinars" },
      { key: "hls_delivery", label: "HLS delivery (large audiences)" },
    ],
  },
];

/** Every key the map files, for the test and for "anything the server added that we did not". */
export function groupedKeys(): string[] {
  return ADMIN_FEATURE_GROUPS.flatMap((g) => g.features.map((f) => f.key));
}

/** One switch as the account panel shows it. */
export type AdminSwitch = {
  key: string;
  label: string;
  description: string;
  perHost: boolean;
  requires: string[];
};

export type AdminSwitchGroup = { id: string; title: string; switches: AdminSwitch[] };

/* The groups for the panel, from the map and the server's catalogue. A catalogue key the map
 * does not list (a switch added on the server first) lands in "Other" with the server's label,
 * so nothing is ever hidden; a mapped key the server does not have is left out. */
export function adminSwitchGroups(catalogue: readonly Feature[], query = ""): AdminSwitchGroup[] {
  const byKey = new Map(catalogue.map((f) => [f.key, f]));
  const q = query.trim().toLowerCase();
  const matches = (s: AdminSwitch) =>
    !q || s.label.toLowerCase().includes(q) || s.key.includes(q) || s.description.toLowerCase().includes(q);
  const toSwitch = (key: string, label: string): AdminSwitch | null => {
    const f = byKey.get(key);
    if (!f) return null;
    return { key, label, description: f.description, perHost: f.perHost ?? false, requires: f.requires ?? [] };
  };
  const out: AdminSwitchGroup[] = ADMIN_FEATURE_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    switches: g.features.map((f) => toSwitch(f.key, f.label)).filter((s): s is AdminSwitch => s !== null),
  }));
  const known = new Set(groupedKeys());
  const other = catalogue.filter((f) => !known.has(f.key)).map((f) => toSwitch(f.key, f.label)!);
  if (other.length) out.push({ id: "other", title: "Other", switches: other });
  return out
    .map((g) => ({ ...g, switches: g.switches.filter(matches) }))
    .filter((g) => g.switches.length > 0);
}

/** The label a switch shows for the given key, for messages. */
export function adminFeatureLabel(key: string): string {
  for (const g of ADMIN_FEATURE_GROUPS) for (const f of g.features) if (f.key === key) return f.label;
  return key;
}

/** The plan names the panel shows. */
export const PLAN_NAMES: Record<string, string> = {
  "": "No plan",
  basic: "Basic",
  professional: "Professional",
  business: "Business",
  enterprise: "Enterprise",
};

export type SwitchState = "plan" | "on" | "off";

/** Where a switch stands for one account: following the plan, or forced on or off. */
export function switchState(user: Pick<AdminUser, "featureOverrides">, key: string): SwitchState {
  const o = user.featureOverrides ?? {};
  if (!(key in o)) return "plan";
  return o[key] ? "on" : "off";
}

/** Whether the account's plan includes the switch; null while the matrix loads. */
export function planGives(tiers: readonly PlanFeatures[] | null, plan: string | undefined, key: string): boolean | null {
  if (!tiers) return null;
  return (tiers.find((t) => t.plan === (plan ?? ""))?.features ?? []).includes(key);
}

/* The words for a switch's state: "From plan (Business): on", "On for this host", "Off for this
 * host". A per-host switch has no plan to follow: "Off: admin only". */
export function switchStateText(
  state: SwitchState,
  plan: string | undefined,
  gives: boolean | null,
  perHost: boolean,
): string {
  if (state === "on") return "On for this host";
  if (state === "off") return "Off for this host";
  if (perHost) return "Off: admin only";
  const name = PLAN_NAMES[plan ?? ""] ?? plan ?? "No plan";
  return gives === null ? `From plan (${name})` : `From plan (${name}): ${gives ? "on" : "off"}`;
}

/** A limit as the panel shows it: the plan's number, and the override when one is set. */
export function limitText(planValue: number, override: number | null | undefined, unit: string): string {
  if (override === null || override === undefined) return `${planValue.toLocaleString("en-IN")} ${unit} (plan)`;
  return `${override.toLocaleString("en-IN")} ${unit} (override; plan ${planValue.toLocaleString("en-IN")})`;
}
