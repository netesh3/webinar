import type { Metadata } from "next";
import { FeaturesPage } from "@/components/marketing/features-page";
import { IOSAppPlansGate } from "@/components/ios-app";
import { TopNav } from "@/components/top-nav";
import { indexable } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Live webinars, meetings and simulive in the browser, registration with email and WhatsApp reminders, polls, Q&A and engagement scores, and AI recaps and follow-ups, on plans from Basic to Enterprise.",
  alternates: { canonical: "/features" },
  // Out of search while its prices are a proposal (lib/plans.ts PLANS_STATUS).
  robots: indexable() ? undefined : { index: false, follow: true },
  openGraph: {
    title: "Webinar Liv features",
    description: "Everything coaches and teachers need to run, fill and sell from their webinars.",
    url: "/features",
    type: "website",
  },
};

/* Open to everyone, like /pricing: it is not in middleware's matcher. */
export default function FeaturesRoute() {
  return (
    <>
      <TopNav />
      <main className="flex-1">
        {/* Carries prices: not in the iOS app (guideline 3.1.1, components/ios-app.tsx). */}
        <IOSAppPlansGate>
          <FeaturesPage />
        </IOSAppPlansGate>
      </main>
    </>
  );
}
