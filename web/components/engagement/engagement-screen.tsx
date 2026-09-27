"use client";

import { useMemo, useSyncExternalStore } from "react";
import { apiSource } from "@/lib/engagement/api-source";
import { fixtureSource } from "@/lib/engagement/source";
import { useDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { EngagementDashboard } from "./engagement-dashboard";
import { DashboardSkeleton } from "./states";

const noSubscribe = () => () => {};

/** The host route's client half: picks the data source, then hands off to the dashboard.
 *  Local preview (dev bypass) has no API behind it, so it reads the sample webinar. */
export function EngagementScreen({ slug }: { slug: string }) {
  const bypass = useDevAuthBypassActive();
  // Bypass is only knowable after hydration; choosing a source before then would fire an
  // API request the preview has no backend to answer.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const source = useMemo(() => (bypass ? fixtureSource() : apiSource(slug)), [bypass, slug]);

  if (!hydrated) return <DashboardSkeleton />;
  return (
    <EngagementDashboard
      source={source}
      sample={bypass}
      backHref={`/host/${slug}`}
      signInHref={`/login?next=${encodeURIComponent(`/host/${slug}/engagement`)}`}
    />
  );
}
