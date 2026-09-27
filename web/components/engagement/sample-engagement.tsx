"use client";

import { useMemo } from "react";
import { fixtureSource } from "@/lib/engagement/source";
import type { DetailTabId } from "./detail-tabs";
import { EngagementDashboard } from "./engagement-dashboard";

/** The Engagement dashboard over the seeded sample webinar, for review without a backend. */
export function SampleEngagement({ initialTab }: { initialTab?: DetailTabId }) {
  const source = useMemo(() => fixtureSource(), []);
  return <EngagementDashboard source={source} sample initialTab={initialTab} />;
}
