import type { Metadata } from "next";
import { TopNav } from "@/components/top-nav";
import { SampleEngagement } from "@/components/engagement/sample-engagement";
import type { DetailTabId } from "@/components/engagement/detail-tabs";

/* The Engagement dashboard over fixture data, for design review and screenshots.
 *
 * Outside the host portal on purpose: it is sample data only, so it must not sit behind the
 * host gate pretending to be a real webinar's numbers, and it has to render with no API. The
 * real page is app/host/(portal)/[id]/engagement and uses the same components. */

export const metadata: Metadata = {
  title: "Engagement (sample)",
  robots: { index: false, follow: false },
};

const DETAIL_TABS: readonly DetailTabId[] = ["chat", "qa", "polls", "reactions", "survey"];

export default async function EngagementMockPage({ searchParams }: PageProps<"/mock/engagement">) {
  const raw = (await searchParams).tab;
  const initialTab = DETAIL_TABS.find((t) => t === raw);
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-5 sm:py-8">
        <SampleEngagement initialTab={initialTab} />
      </main>
    </>
  );
}
