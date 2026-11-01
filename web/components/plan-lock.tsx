"use client";

import type { ReactNode } from "react";
import { useSession } from "./providers";
import { PlanLock } from "./ui";

export { PlanBadge, PlanLock, UpgradeLink } from "./ui";

/* A gated feature, for a host whose plan lacks it (1 Nov 2026): shown, not hidden, and not a
 * control that fails. The badge names the lowest plan with the feature ("Business and up", from
 * lib/plan-gate.ts, which reads the same tiers as the pricing table) and "Upgrade" goes to the
 * plans. Whether the host HAS it is Account.features, which counts an admin's overrides
 * (useHasFeature). A per-host switch names no plan, and its surface stays hidden as before. */

/** The signed-in account has the switch, from its plan or an admin's override. */
export function useHasFeature(key: string): boolean {
  const { account } = useSession();
  return (account?.features ?? []).includes(key);
}

/** The control when the host has the feature, else the lock. */
export function PlanGate({
  feature,
  title,
  note,
  children,
}: {
  feature: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  const has = useHasFeature(feature);
  if (has) return <>{children}</>;
  return (
    <PlanLock feature={feature} title={title}>
      {note}
    </PlanLock>
  );
}
