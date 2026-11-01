/* Which plan a feature is on, for the "Business and up" badges on locked controls (1 Nov 2026).
 *
 * Read from lib/plans.ts (TIER_FEATURES and the plan limits), the same data the pricing table
 * and the server's tiers are checked against (api/internal/billing/web_plans_test.go), so a
 * badge cannot name a plan that does not include the feature. Whether a host HAS the feature
 * is their Account.features, which counts an admin's overrides; this only says where to get it.
 * Per-host switches (clips, instant sessions, HLS) are on no plan: no badge, and their
 * surfaces stay hidden.
 *
 * Pure, so it is tested on its own (plan-gate.test.mts). */

import { PER_HOST_FEATURES, PLAN_IDS, TIER_FEATURES, findPlan, type Plan, type PlanLimits } from "./plans.ts";

/** The chat spam filter has no switch of its own: it comes with ai (api.spamCheck). */
export const SPAM_FILTER_FEATURE = "ai";

/** The lowest plan that includes the switch, or null for one no plan sells (or every plan has). */
export function lowestPlanFor(feature: string): Plan | null {
  if (PER_HOST_FEATURES.includes(feature)) return null;
  const id = PLAN_IDS.find((p) => TIER_FEATURES[p].includes(feature));
  return id ? findPlan(id) : null;
}

/** "Professional and up", "Business and up", "Enterprise", or null with no plan to name. */
export function planBadgeFor(feature: string): string | null {
  const plan = lowestPlanFor(feature);
  if (!plan) return null;
  return plan.id === "enterprise" ? plan.name : `${plan.name} and up`;
}

/** The lowest plan whose limit reaches `need` (people on stage, per meeting, storage GB). */
export function lowestPlanForLimit(limit: keyof PlanLimits, need: number): Plan | null {
  const id = PLAN_IDS.find((p) => findPlan(p).limits[limit] >= need);
  return id ? findPlan(id) : null;
}

/** Where "Upgrade" goes: the plans on /pricing (a signed-in host buys there too). */
export function upgradeHref(): string {
  return "/pricing#pricing";
}
