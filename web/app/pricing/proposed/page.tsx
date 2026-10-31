import { permanentRedirect } from "next/navigation";

/* The proposed price list went live on 31 Oct 2026 (lib/plans.ts PLANS_STATUS): its plans are
 * on sale and its comparison table is on /pricing, so the old address goes there. */
export default function ProposedPricingRoute() {
  permanentRedirect("/pricing");
}
