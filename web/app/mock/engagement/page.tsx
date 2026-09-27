import type { Metadata } from "next";
import { TopNav } from "@/components/top-nav";
import { SampleEngagement } from "@/components/engagement/sample-engagement";
import { SECTIONS } from "@/lib/engagement/sections";

/* The Engagement dashboard over fixture data, for design review and screenshots.
 *
 * Outside the host portal on purpose: it is sample data only, so it must not sit behind the
 * host gate pretending to be a real webinar's numbers, and it has to render with no API. The
 * real page is app/host/(portal)/[id]/engagement and uses the same components. */

export const metadata: Metadata = {
  title: "Engagement (sample)",
  robots: { index: false, follow: false },
};

export default async function EngagementMockPage({ searchParams }: PageProps<"/mock/engagement">) {
  // ?tab= is the older spelling, from when the details were tabs; ?section= reads better now.
  const params = await searchParams;
  const raw = params.section ?? params.tab;
  const initialSection = SECTIONS.find((x) => x.id === raw)?.id;
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-5 sm:py-8">
        <SampleEngagement initialSection={initialSection} />
      </main>
    </>
  );
}
