import type { Metadata } from "next";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { AddOns, AiCredits, CompareTable, FinalCta, PlanCards, PlansFaq, ProposalNote } from "@/components/marketing/plans-ui";
import { IOSAppPlansGate } from "@/components/ios-app";
import { TopNav } from "@/components/top-nav";
import { indexable } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Pricing (proposed)",
  description:
    "Webinar Liv plans for coaches, teachers and academies: Starter, Pro and Business in INR or USD, with a 7-day free trial, AI credits and add-ons.",
  alternates: { canonical: "/pricing/proposed" },
  robots: indexable() ? undefined : { index: false, follow: true },
};

/* The proposed price list (lib/plans.ts), for review next to the live /pricing. When the
 * server charges these plans, this page's sections move onto /pricing above its checkout
 * and this route goes (docs/pricing-proposal.md, "Going live"). */
export default function ProposedPricingRoute() {
  return (
    <>
      <TopNav />
      <main className="flex-1">
        {/* Not in the iOS app (guideline 3.1.1, components/ios-app.tsx). */}
        <IOSAppPlansGate>
          <div className="home">
            <div className="lp lp-pricing-page">
              <ProposalNote />
              <PlanCards headingLevel={2} />
              <AddOns />
              <CompareTable />
              <AiCredits />
              <PlansFaq />
              <FinalCta
                title={
                  <>
                    Start free. <em>Upgrade when you grow.</em>
                  </>
                }
              />
            </div>
            <HomeLegalFooter />
          </div>
        </IOSAppPlansGate>
      </main>
    </>
  );
}
