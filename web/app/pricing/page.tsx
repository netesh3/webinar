import type { Metadata } from "next";
import { Suspense } from "react";
import { PricingPage } from "@/components/marketing/home-page";
import { IOSAppPlansGate } from "@/components/ios-app";
import { TopNav } from "@/components/top-nav";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Webinar Liv plans for coaches, teachers and academies. Pay with UPI, cards or netbanking and start hosting straight away.",
  alternates: { canonical: "/pricing" },
};

/* The price list and checkout. Open to everyone, signed in or not — it is not in
 * middleware's matcher — because this is where a signed-in account that cannot host
 * yet comes to buy, and where sign-up returns a buyer with ?buy=… to finish. */
export default function PricingRoute() {
  return (
    <>
      <TopNav />
      <main className="flex-1">
        {/* In the iOS app, no price list and no checkout, only a neutral line (App Store
            guideline 3.1.1, components/ios-app.tsx). (29 Oct 2026) */}
        <IOSAppPlansGate>
          {/* PricingPage reads ?buy= with useSearchParams. */}
          <Suspense>
            <PricingPage />
          </Suspense>
        </IOSAppPlansGate>
      </main>
    </>
  );
}
