import type { Metadata } from "next";
import { Suspense } from "react";
import { PricingPage } from "@/components/marketing/home-page";
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
        {/* PricingPage reads ?buy= with useSearchParams. */}
        <Suspense>
          <PricingPage />
        </Suspense>
      </main>
    </>
  );
}
